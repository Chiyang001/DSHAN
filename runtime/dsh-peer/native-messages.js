import { setTimeout as delay } from 'node:timers/promises';

export const mirrorId = chat => 'peer-linked-' + chat.id;
const cursor = chat => chat.events.length - 1;
const journal = chat => {
  const seqs = new Map(chat.events.map((event, index) => [event.seq, index]));
  return chat.events.map((event, seq) => ({ ...event, seq, ...(typeof event.surfaceOp === 'object' ? { surfaceOp: { ...event.surfaceOp, startSeq: seqs.get(event.surfaceOp.startSeq) ?? 0, endSeq: seqs.get(event.surfaceOp.endSeq) ?? Math.max(0, seq - 1) } } : {}) }));
};
const project = chat => ({ asOfSeq: cursor(chat), values: { ...(chat.nativeProjections?.values ?? {}), title: chat.title } });
const summary = chat => ({ sessionId: mirrorId(chat), updatedAt: chat.updatedAt, running: !!chat.running, blank: !chat.events.some(e => e.type === 'user/message'), agentAvailable: true, projections: { kind: 'sequenced', ...project(chat) } });

// Adapt selected remote conversations to the ordinary Session API. No local Agent
// is created for a mirror: every mutating request is addressed to its one owner.
export function installNativeMessages(ctx, linked) {
  const controller = ctx.get('sessionController');
  if (!controller) return () => {};
  const original = {}, replacements = {}, lifetime = new AbortController();
  const mirrored = id => Object.values(linked.data?.chats ?? {}).find(chat => !chat.removed && chat.owner !== linked.data.deviceId && mirrorId(chat) === id);
  const replace = (name, handler) => {
    if (typeof controller[name] !== 'function') return;
    original[name] = controller[name];
    const replacement = function (...args) { return handler.call(this, original[name].bind(this), ...args); };
    replacements[name] = replacement; controller[name] = replacement;
  };
  const remote = async (chat, method, request, signal) => linked.nativeCall(chat, method, request, signal);
  replace('list', async (next, request, signal) => {
    await linked.init(); const result = await next(request, signal);
    const deleted = new Set(Object.values(linked.data.chats).filter(c => c.removed && c.deletion && c.owner === linked.data.deviceId).map(c => c.sessionId));
    return { ...result, items: [...result.items.filter(item => !deleted.has(item.sessionId) && !item.sessionId.startsWith('peer-toolhost-')), ...Object.values(linked.data.chats).filter(chat => !chat.removed && chat.owner !== linked.data.deviceId).map(summary)] };
  });
  for (const method of ['selectModel', 'rename', 'updateQueue', 'cancel', 'attachment']) replace(method, async (next, request, signal) => {
    const chat = mirrored(request.sessionId); if (!chat) return next(request, signal);
    return remote(chat, method, request, signal);
  });
  replace('modelCatalog', async (next) => {
    const catalog = await next();
    const groups = new Map(catalog.groups.map(group => [group.id, { ...group, models: [...group.models] }]));
    for (const chat of Object.values(linked.data?.chats ?? {})) if (!chat.removed && chat.owner !== linked.data.deviceId) {
      for (const group of chat.nativeCatalog?.groups ?? []) {
        if (!groups.has(group.id)) groups.set(group.id, group);
        else { const current = groups.get(group.id); for (const model of group.models) if (!current.models.some(item => item.id === model.id)) current.models.push(model); }
      }
    }
    return { ...catalog, groups: [...groups.values()] };
  });
  replace('prompt', async (next, request, signal) => {
    if (Object.values(linked.data?.chats ?? {}).some(c => c.removed && c.deletion && (c.owner === linked.data.deviceId ? c.sessionId : mirrorId(c)) === request.sessionId)) throw Error('此联动会话已删除');
    const chat = mirrored(request.sessionId);
    if (!chat) {
      const owned = Object.values(linked.data?.chats ?? {}).find(c => !c.removed && c.owner === linked.data.deviceId && c.sessionId === request.sessionId);
      if (owned) await linked.prepareSession?.(owned.sessionId);
      const result = await next(request, signal);
      if (owned) { await linked.refresh(owned); linked.touch(); }
      return result;
    }
    await linked.action({ action: 'send', id: chat.id, ...request, text: request.content.filter(part => part.type === 'text').map(part => part.text).join('\n') });
    return { accepted: true };
  });
  replace('projections', async (next, request, signal) => {
    const chat = mirrored(request.sessionId); return chat ? project(chat) : next(request, signal);
  });
  replace('page', async (next, request, signal) => {
    const chat = request.address?.kind === 'session' && mirrored(request.address.sessionId);
    if (!chat) return next(request, signal);
    const events = journal(chat).filter(event => event.seq <= request.throughSeq && (request.beforeSeq === undefined || event.seq < request.beforeSeq));
    const selected = events.slice(-Math.min(1000, request.maxMessages ?? 100));
    return { records: selected.map(event => ({ type: 'event', event })), hasMore: selected.length < events.length };
  });
  replace('follow', (next, request, signal) => {
    const chat = request.address?.kind === 'session' && mirrored(request.address.sessionId);
    if (!chat) return next(request, signal);
    signal = AbortSignal.any([signal, lifetime.signal]);
    return (async function* () {
      // The existing native renderer, composer, model picker and upload pipeline
      // consume this same journal contract as an ordinary conversation.
      const events = journal(chat).slice(-Math.min(1000, request.maxMessages ?? 100));
      let through = cursor(chat), live = '', attempt, index = 0, revision = 0, epoch = chat.journalEpoch ?? 0;
      yield { type: 'snapshot', header: { version: 4, id: mirrorId(chat), createdAt: chat.updatedAt, isSeeded: false }, cursor: through,
        records: events.map(event => ({ type: 'event', event })), hasMore: events.length < chat.events.length, projections: project(chat), assistantStream: { revision: 0 } };
      while (!signal.aborted && !linked.disposed && !chat.removed) {
        if (epoch !== (chat.journalEpoch ?? 0)) {
          epoch = chat.journalEpoch ?? 0; through = cursor(chat); live = ''; attempt = undefined; index = 0;
          const records = journal(chat).slice(-Math.min(1000, request.maxMessages ?? 100));
          yield { type: 'snapshot', header: { version: 4, id: mirrorId(chat), createdAt: chat.updatedAt, isSeeded: false }, cursor: through,
            records: records.map(event => ({ type: 'event', event })), hasMore: records.length < chat.events.length, projections: project(chat), assistantStream: { revision } };
        }
        const appended = journal(chat).filter(event => event.seq > through);
        if (attempt && (appended.length || !(chat.live ?? '').startsWith(live))) {
          yield { type: 'assistant-stream', frame: { type: 'end', attemptId: attempt, revision: ++revision, index, outcome: { kind: 'abandoned' } } };
          attempt = undefined; index = 0; live = '';
        }
        for (const event of appended) { through = event.seq; yield { type: 'event', event }; }
        const text = chat.live ?? '';
        if (request.assistantStream && live !== text) {
          if (!attempt && text) {
            attempt = 'peer-' + chat.id + '-' + revision;
            const position = chat.livePosition ?? [...chat.events].reverse().find(e => e.type === 'step/start')?.data ?? { turn: 1, step: 1 };
            yield { type: 'assistant-stream', frame: { type: 'start', attemptId: attempt, revision: ++revision, startedAfterSeq: through, turn: position.turn, step: position.step } };
            yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: ++revision, index: index++, time: Date.now(), chunk: { type: 'block-start', index: 0, blockType: 'text' } } };
          }
          if (text && attempt) yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: ++revision, index: index++, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: text.slice(live.length) } } };
          if (!text && attempt) {
            yield { type: 'assistant-stream', frame: { type: 'end', attemptId: attempt, revision: ++revision, index, outcome: { kind: 'abandoned' } } };
            attempt = undefined; index = 0;
          }
          live = text;
        }
        await delay(150, undefined, { signal }).catch(() => {});
      }
    })();
  });
  replace('control', (next, signal) => (async function* () {
    signal = AbortSignal.any([signal, lifetime.signal]);
    const queue = [], seen = new Map(); let wake, closed = false, baseline = false, failure;
    const notify = () => { wake?.(); wake = undefined; };
    const mirroredChats = () => Object.values(linked.data?.chats ?? {}).filter(chat => !chat.removed && chat.owner !== linked.data.deviceId);
    const producer = (async () => {
      try { for await (let frame of next(signal)) {
        if (closed) break;
        if (frame.type === 'baseline') {
          frame = { ...frame, value: { ...frame.value, projections: { ...frame.value.projections, ...Object.fromEntries(mirroredChats().map(chat => [mirrorId(chat), project(chat)])) } } };
          baseline = true;
        }
        queue.push(frame); notify();
      } } catch (error) { if (!signal.aborted) failure = error; } finally { notify(); }
    })();
    const timer = setInterval(() => {
      if (!baseline || closed) return;
      for (const chat of mirroredChats()) for (const [key, value] of Object.entries(project(chat).values)) {
        const id = mirrorId(chat), fingerprint = JSON.stringify(value), identity = id + ':' + key;
        if (seen.get(identity) === fingerprint) continue; seen.set(identity, fingerprint);
        queue.push({ type: 'projection', sessionId: id, key, value, seq: cursor(chat) });
      }
      if (queue.length) notify();
    }, 400); timer.unref();
    signal.addEventListener('abort', notify);
    try { while (!signal.aborted && !linked.disposed) {
      if (failure) throw failure;
      if (queue.length) yield queue.shift();
      else await new Promise(resolve => { wake = resolve; if (signal.aborted) notify(); });
    } } finally { closed = true; clearInterval(timer); signal.removeEventListener('abort', notify); void producer; }
  })());
  const uploads = ctx.get('fileUploads'); let previousUpload, replacementUpload;
  if (uploads?.uploadStream) {
    previousUpload = uploads.uploadStream;
    replacementUpload = async function (request) {
      const chat = mirrored(request.sessionId); if (!chat) return previousUpload.call(this, request);
      const chunks = []; let size = 0;
      for await (const bytes of request.data) { size += bytes.length; if (size > 8 * 1024 * 1024) throw Error('联动附件最大支持 8 MiB'); chunks.push(Buffer.from(bytes)); }
      return remote(chat, 'upload', { data: Buffer.concat(chunks).toString('base64'), name: request.name }, request.signal);
    };
    uploads.uploadStream = replacementUpload;
  }
  const known = new Map(), removed = new Set();
  const timer = setInterval(() => {
    for (const chat of Object.values(linked.data?.chats ?? {})) {
      if (chat.owner === linked.data.deviceId && !(chat.removed && chat.deletion)) continue;
      const id = chat.owner === linked.data.deviceId ? chat.sessionId : mirrorId(chat), value = JSON.stringify([chat.version, chat.running, chat.title, chat.nativeProjections]);
      if (chat.removed) { known.delete(id); if (!removed.has(id)) { removed.add(id); ctx.emit('api-session/removed', id); } continue; }
      if (known.get(id) !== value) { known.set(id, value); ctx.emit('api-session/added', summary(chat)); ctx.emit('api-session/status', id, !!chat.running); }
    }
  }, 400); timer.unref();
  return () => {
    lifetime.abort(); clearInterval(timer);
    for (const [name, replacement] of Object.entries(replacements)) if (controller[name] === replacement) controller[name] = original[name];
    if (uploads && uploads.uploadStream === replacementUpload) uploads.uploadStream = previousUpload;
  };
}
