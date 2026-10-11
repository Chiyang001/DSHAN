import { KernelUpdater } from './kernel-updater.js'

export const inject = ['webServer', 'connection']

export function apply(ctx) {
  const updater = new KernelUpdater()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/android/kernel-update',
    async handler(req, res) {
      if (!ctx.connection.authorizeIndex(req, res)) return
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        await updater.initialized
        let result
        if (req.method === 'GET') result = updater.snapshot()
        else if (req.method === 'POST') {
          if (req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(JSON.stringify({ error: '请求来源无效' })); return }
          let body = ''
          for await (const chunk of req) { body += chunk.toString(); if (body.length > 2048) throw new Error('请求内容过长') }
          const { action } = JSON.parse(body)
          if (!['check', 'start', 'cancel', 'restart'].includes(action)) throw new Error('未知更新操作')
          result = await updater[action]()
        } else { res.writeHead(405); res.end(JSON.stringify({ error: '请求方法无效' })); return }
        res.end(JSON.stringify(result))
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message ?? '更新操作失败' })) }
    },
  }), 'Kernel update endpoint')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/android/settings',
    async handler(req, res) {
      if (!ctx.connection.authorizeIndex(req, res)) return
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        let request = { method: 'androidSettings' }
        if (req.method === 'POST') {
          if (req.headers.origin !== `http://${req.headers.host}`) {
            res.writeHead(403)
            res.end(JSON.stringify({ error: '请求来源无效' }))
            return
          }
          let body = ''
          for await (const chunk of req) {
            body += chunk.toString()
            if (body.length > 2048) throw new Error('请求内容过长')
          }
          const input = JSON.parse(body)
          if (!['updateAndroidSettings', 'requestShizuku', 'requestAdbPairing', 'requestRoot', 'openStorageSettings', 'openOverlaySettings', 'createVirtualDisplay', 'closeVirtualDisplay', 'openDisplaySettings'].includes(input.method)) throw new Error('未知设置操作')
          request = { method: input.method }
          for (const key of ['controlEnabled', 'shellEnabled', 'rootEnabled', 'virtualDisplayAllowed']) {
            if (input[key] !== undefined) {
              if (typeof input[key] !== 'boolean') throw new Error('开关值无效')
              request[key] = input[key]
            }
          }
        } else if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end(JSON.stringify({ error: '请求方法无效' }))
          return
        }
        const response = await fetch('http://127.0.0.1:3981/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-bridge-token': process.env.DSH_ANDROID_BRIDGE_TOKEN },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(10000),
        })
        const result = await response.json()
        res.writeHead(response.ok ? 200 : 400)
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message ?? '设置操作失败' }))
      }
    },
  }), 'Android settings HTTP endpoint')
}
