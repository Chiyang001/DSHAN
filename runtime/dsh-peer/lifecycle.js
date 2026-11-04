import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mirrorId } from './native-messages.js';

const activeMirrors = linked => Object.values(linked.data?.chats ?? {}).filter(c => !c.removed && c.owner !== linked.data.deviceId);
const mirror = (linked, id) => activeMirrors(linked).find(c => mirrorId(c) === id);

// Virtual sessions belong to the peer store, never the local Workspace registry.
// Keep presentation preferences local and merge them into every complete set.
export function installLinkedWorkspace(ctx, linked) {
  const service = ctx.get('workspaceController'), registry = ctx.get('workspaceRegistry');
  if (!service) return () => {};
  const restores = [], lifetime = new AbortController();
  const sessionId = c => c.owner === linked.data.deviceId ? c.sessionId : mirrorId(c);
  const merge = (ids = [], key) => {
    const chats = Object.values(linked.data?.chats ?? {});
    const overrides = new Map(chats.filter(c => c.removed || c[key] !== undefined).map(c => [sessionId(c), !c.removed && !!c[key]]));
    return [...new Set([...ids.filter(id => !id.startsWith('peer-linked-') && overrides.get(id) !== false), ...chats.filter(c => !c.removed && c[key]).map(sessionId)])];
  };
  const patch = (name, make) => {
    const original = service[name]; if (typeof original !== 'function') return;
    const wrapped = make(original.bind(service)); service[name] = wrapped;
    restores.push(() => { if (service[name] === wrapped) service[name] = original; });
  };
  linked.workspace = () => registry;
  linked.workspaceController = () => service;
  for (const [name, key, value, field] of [
    ['pinSession', 'pinned', true, 'pinnedSessionIds'], ['unpinSession', 'pinned', false, 'pinnedSessionIds'],
    ['archiveSession', 'archived', true, 'archivedSessionIds'], ['unarchiveSession', 'archived', false, 'archivedSessionIds'],
  ]) patch(name, next => async (request, signal) => {
    await linked.init(); const chat = Object.values(linked.data.chats).find(c => !c.removed && (c.owner === linked.data.deviceId ? c.sessionId : mirrorId(c)) === request.sessionId);
    if (!chat) { const result = await next(request, signal); linked.touch(false); return { ...result, [field]: merge(result[field], key) }; }
    if (key === 'pinned' && value && chat.archived) throw Error('请先取消归档，再置顶会话');
    if (key === 'archived' && value && chat.running) {
      if (!request.stopActivity) throw Error('会话正在执行，请先停止任务再归档');
      if (chat.owner === linked.data.deviceId) await linked.controller().cancel({ sessionId: chat.sessionId }, signal);
      else await linked.nativeCall(chat, 'cancel', {}, signal);
    }
    if (key === 'archived' && chat.owner === linked.data.deviceId) await next(request, signal);
    chat[key] = value; if (key === 'archived' && value) chat.pinned = false;
    await linked.save(); linked.touch(false);
    return { [field]: merge(registry?.[field], key) };
  });
  patch('follow', next => signal => (async function* () {
    await linked.init(); signal = AbortSignal.any([signal, lifetime.signal]);
    const queue = []; let wake, stopped = false, failure, ready = false;
    let native = { pinnedSessionIds: [], archivedSessionIds: [] }, previous = {};
    const notify = () => { wake?.(); wake = undefined; };
    const values = () => ({ pinnedSessionIds: merge(native.pinnedSessionIds, 'pinned'), archivedSessionIds: merge(native.archivedSessionIds, 'archived') });
    const producer = (async () => {
      try { for await (const frame of next(signal)) {
        if (stopped) break;
        if (frame.type === 'baseline') {
          native = frame.value; ready = true; const sets = values(); previous = sets;
          queue.push({ ...frame, value: { ...frame.value, ...sets } });
        } else if (frame.type === 'pinned' || frame.type === 'archived') {
          const field = frame.type === 'pinned' ? 'pinnedSessionIds' : 'archivedSessionIds';
          native = { ...native, [field]: frame[field] }; const sets = values(); previous[field] = sets[field];
          queue.push({ ...frame, [field]: sets[field] });
        } else queue.push(frame);
        notify();
      } } catch (error) { if (!signal.aborted) failure = error; notify(); }
    })();
    const timer = setInterval(() => {
      if (!ready || stopped) return;
      const sets = values();
      for (const [field, type] of [['pinnedSessionIds', 'pinned'], ['archivedSessionIds', 'archived']]) if (JSON.stringify(sets[field]) !== JSON.stringify(previous[field])) {
        previous[field] = sets[field]; queue.push({ type, [field]: sets[field] }); notify();
      }
    }, 100); timer.unref(); signal.addEventListener('abort', notify);
    try { while (!signal.aborted && !linked.disposed) {
      if (failure) throw failure;
      if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; if (signal.aborted) notify(); });
    } } finally { stopped = true; clearInterval(timer); signal.removeEventListener('abort', notify); void producer; }
  })());
  return () => { lifetime.abort(); for (const restore of restores.reverse()) restore(); };
}

// Use the owner's existing permanent-delete service when present. Android also
// needs a JSONL fallback: drain the exact Agent handle, validate containment and
// acquire the write lease before atomically removing its session directory.
export function installLinkedDeletion(ctx, linked) {
  const handles = new Map(), deleting = new Set(), restores = [];
  const agents = ctx.get('agents');
  for (const name of ['create', 'resume']) if (typeof agents?.[name] === 'function') {
    const original = agents[name];
    const wrapped = async function (...args) { const handle = await original.apply(this, args); const id = handle?.agent?.session?.id ?? handle?.agent?.id; if (id) handles.set(id, handle); return handle; };
    agents[name] = wrapped; restores.push(() => { if (agents[name] === wrapped) agents[name] = original; });
  }
  const remove = async (request, signal = AbortSignal.timeout(30000)) => {
    const step = operation => {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    };
    const id = request.sessionId;
    if (request.confirm !== true || typeof id !== 'string' || !id) throw Error('需要明确确认永久删除会话');
    if (deleting.has(id)) throw Error('此会话正在删除');
    deleting.add(id); let restoreArchive = false;
    const registry = ctx.get('workspaceRegistry'), persistence = ctx.get('sessionPersistence'), sessions = ctx.get('sessions');
    try {
      if (!registry || !sessions || typeof persistence?.locate !== 'function' || typeof persistence.config?.root !== 'string') throw Error('执行设备暂不支持永久删除，请更新执行设备内核');
      const stored = await step(() => persistence.stat(id)); if (!stored) { ctx.emit('api-session/removed', id); return { deleted: true, sessionId: id }; }
      if (stored.header.id !== id) throw Error('会话标识校验失败');
      if ((await step(() => persistence.list())).some(row => row.header.parentId === id)) throw Error('此会话仍有子会话，请先删除子会话');
      const location = persistence.locate(stored.header); if (location?.kind !== 'jsonl') throw Error('不支持此会话存储格式');
      const root = await realpath(resolve(persistence.config.root)), target = dirname(location.path), actual = await realpath(target);
      const encoded = id === '.' ? '~002E' : id === '..' ? '~002E~002E' : Array.from(id).map(ch => /^[A-Za-z0-9._-]$/.test(ch) ? ch : Array.from({ length: ch.length }, (_, i) => '~' + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')).join('')).join('');
      const offset = relative(root, actual);
      if (!offset || offset.startsWith('..') || isAbsolute(offset) || actual !== resolve(await realpath(dirname(target)), encoded) || basename(actual) !== encoded || (await lstat(target)).isSymbolicLink()) throw Error('会话存储路径校验失败');
      const archived = registry.archivedSessionIds.includes(id);
      await step(() => registry.archiveSession(id, { stopActivity: true })); restoreArchive = !archived;
      await step(() => ctx.parallel('workspace/session-stop', { sessionId: id }));
      const handle = handles.get(id); if (handle) { await step(() => handle.dispose()); handles.delete(id); }
      if (sessions.get(id)) throw Error('无法释放此会话的运行时占用，请重启执行设备后重试');
      // If lease acquisition finishes after timeout, release that late lease too.
      const opening = Promise.resolve().then(() => { signal.throwIfAborted(); return persistence.open(id, 'write'); });
      opening.then(lease => { if (signal.aborted) void lease.close().catch(() => {}); }, () => {});
      const lease = await step(() => opening);
      try {
        if (sessions.get(id)) throw Error('会话已被打开，删除已取消');
        // Recheck the actual target after asynchronous cancellation/lease work.
        if (await realpath(target) !== actual || (await lstat(target)).isSymbolicLink()) throw Error('会话存储路径已变化');
      } finally {
        const closing = Promise.resolve().then(() => lease.close());
        void closing.catch(() => {});
        await step(() => closing);
      }
      signal.throwIfAborted();
      const tomb = resolve(dirname(actual), '.peer-delete-' + randomUUID());
      const tombOffset = relative(root, tomb);
      if (!tombOffset || tombOffset.startsWith('..') || isAbsolute(tombOffset)) throw Error('删除路径校验失败');
      await rename(actual, tomb);
      await rm(tomb, { recursive: true, force: false });
      // The journal is already gone: registry cleanup failure must not turn a
      // completed permanent deletion into a retry against a missing journal.
      await registry.unarchiveSession(id).catch(() => {});
      await registry.unpinSession?.(id).catch(() => {});
      ctx.emit('api-session/removed', id);
      return { deleted: true, sessionId: id };
    } catch (error) { if (restoreArchive && !signal.aborted) await step(() => registry.unarchiveSession(id)).catch(() => {}); throw error; }
    finally { deleting.delete(id); }
  };
  linked.deleteSession = remove;
  return () => { if (linked.deleteSession === remove) delete linked.deleteSession; for (const restore of restores.reverse()) restore(); handles.clear(); };
}

export function installLinkedThemeActions(ctx, linked) {
  const service = ctx.get('codshActions'); if (typeof service?.deleteSession !== 'function') return () => {};
  const original = service.deleteSession;
  const wrapped = async function (request, ...args) {
    await linked.init(); const chat = Object.values(linked.data.chats).find(c => (c.owner === linked.data.deviceId ? c.sessionId : mirrorId(c)) === request?.sessionId && (!c.removed || c.deletion));
    if (chat) {
      if (request.confirm !== true) throw Error('需要明确确认永久删除会话');
      return linked.deleteChat(chat, AbortSignal.timeout(60000));
    }
    const result = await original.call(this, request, ...args);
    for (const item of Object.values(linked.data.chats)) if (!item.removed && item.owner === linked.data.deviceId && item.sessionId === request.sessionId) await linked.forget(item);
    return result;
  };
  service.deleteSession = wrapped;
  return () => { if (service.deleteSession === wrapped) service.deleteSession = original; };
}
