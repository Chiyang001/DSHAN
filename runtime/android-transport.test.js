import { test } from 'node:test'
import assert from 'node:assert/strict'

for (const transport of ['wireless-adb', 'shizuku']) {
  test(`Android mode uses the native bridge for ${transport} main-screen operations`, async () => {
    const originalFetch = globalThis.fetch
    const originalToken = process.env.DSH_ANDROID_BRIDGE_TOKEN
    process.env.DSH_ANDROID_BRIDGE_TOKEN = 'transport-test'
    const calls = [], tools = new Map()
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body)
      calls.push(request)
      const value = request.method === 'status' ? { connected: true, transport, controlEnabled: true }
        : request.method === 'displays' ? { displays: [{ displayId: 0 }] }
        : request.method === 'screenshot' ? { path: '/test-screen.png', width: 720, height: 1280,
          rotation: 0, displayId: 0, fingerprint: String(calls.length) }
        : { ok: true, exitCode: 0, displayId: 0, transport, output: '' }
      return { ok: true, json: async () => value }
    }
    try {
      const { apply } = await import(`./android-tools.js?transport=${transport}`)
      apply({ tools: { register: tool => tools.set(tool.name, tool) }, on() {} })
      const exec = { agent: { session: {} }, signal: new AbortController().signal }
      const invoke = (name, args = {}) => tools.get(name).execute(args, exec)
      assert.match(await invoke('android_status'), new RegExp(transport))
      await invoke('android_displays')
      await invoke('android_screenshot')
      await invoke('android_tap', { x: 10, y: 20 })
      await invoke('android_text', { text: 'test' })
      await invoke('android_key', { keycode: 4 })
      for (const method of ['tap', 'text', 'key']) {
        assert.equal(calls.find(call => call.method === method).displayId, 0)
      }
    } finally {
      globalThis.fetch = originalFetch
      if (originalToken === undefined) delete process.env.DSH_ANDROID_BRIDGE_TOKEN
      else process.env.DSH_ANDROID_BRIDGE_TOKEN = originalToken
    }
  })
}
