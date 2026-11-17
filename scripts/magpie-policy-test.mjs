/**
 * The magpie branch offers the channels upstream main excludes.
 *
 * This suite pins the branch-local policy: nothing is filtered or refused on
 * the routes upstream uses to keep WorkBuddy and Huawei Cloud out. Engine-backed
 * checks use the real pinned executable, like magpie-engine-test, and are
 * skipped on platforms without one; the pure-function group always runs.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createMagpieEngine, MAGPIE_UI_PREFIX as prefix } from '../src/magpie-engine.js'
import {
  assertEngineMutation, deniedLookup, deniedModel, filterEngineJSON, isDeniedChannel,
  policyMutation, policyResponse, POLICY_REFUSED,
} from '../src/magpie-policy.js'
import { pinnedEngineEntry } from './lib/engine-binary.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-policy-'))
const saved = new Map()
for (const [name, value] of Object.entries({
  HOME: path.join(scratch, 'native-home'),
  USERPROFILE: path.join(scratch, 'native-home'),
  XDG_CONFIG_HOME: path.join(scratch, 'native-config'),
  XDG_CACHE_HOME: path.join(scratch, 'native-cache'),
  XDG_DATA_HOME: path.join(scratch, 'native-data'),
  XDG_STATE_HOME: path.join(scratch, 'native-state'),
})) {
  saved.set(name, process.env[name])
  process.env[name] = value
  fs.mkdirSync(value, { recursive: true })
}

const PACKAGE = '@magpie-community/opencode-workbuddy-auth'
const engine = createMagpieEngine({ dataDir: path.join(scratch, 'data'), logger: {} })
let checks = 0
const check = async (name, run) => {
  await run()
  checks++
  console.log(`ok ${checks} - ${name}`)
}
const server = http.createServer((req, res) => {
  const subpath = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url
  engine.proxy(req, res, subpath).catch(() => { try { res.destroy() } catch {} })
})
const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
const notRefused = async (method, route, body) => {
  try {
    const response = await engine.request(method, route, body === undefined ? {} : { body })
    await response.text()
    return true
  } catch (error) {
    return error.message !== POLICY_REFUSED
  }
}

try {
  await check('no channel is denied by the branch policy', async () => {
    for (const id of ['workbuddy', 'workbuddy-ai', 'codebuddy', 'codebuddy-cn', 'huaweicloud', 'codearts']) {
      assert.equal(isDeniedChannel(id, id), false, id)
    }
    assert.equal(isDeniedChannel('zcode', 'ZCode'), false)
    assert.equal(deniedLookup('/api/plugins/page', new URLSearchParams({ name: PACKAGE })), false)
    assert.equal(deniedModel({ id: 'workbuddy/glm-5.3-flash', owned_by: 'workbuddy' }), false)
    assert.equal(deniedModel({ id: 'codearts/glm-5.3-flash', owned_by: 'codearts' }), false)
  })

  await check('every engine answer and mutation passes through unchanged', async () => {
    for (const route of ['/api/plugins/listings', '/api/plugins/market', '/api/providers',
      '/api/upstream', '/api/plugins/npm', '/api/login/usage']) {
      assert.equal(policyResponse(route), false, route)
      const sample = { route, providers: ['workbuddy', 'huaweicloud'], text: 'WorkBuddy 华为云' }
      assert.equal(filterEngineJSON(route, sample), sample, `${route}: same object`)
      assert.deepEqual(sample, { route, providers: ['workbuddy', 'huaweicloud'], text: 'WorkBuddy 华为云' }, `${route}: untouched`)
    }
    for (const [method, route, body] of [
      ['POST', '/api/plugins/add', { spec: PACKAGE }],
      ['POST', '/api/plugins/upgrade', { spec: PACKAGE }],
      ['POST', '/api/plugins/off', { spec: PACKAGE, off: false }],
      ['POST', '/api/plugin-signin', { provider: 'workbuddy', method: 0 }],
      ['POST', '/api/signin', { agent: 'workbuddy-ai' }],
      ['POST', '/api/login/use', { agent: 'codearts' }],
      ['POST', '/api/provider/move', { id: 'huaweicloud' }],
      ['POST', '/api/provider/save', { preset: 'codebuddy', key: 'fixture' }],
    ]) {
      assert.equal(policyMutation(method, route), false, `${method} ${route}`)
      assert.doesNotThrow(() => assertEngineMutation(method, route, body), `${method} ${route}`)
    }
    assert.equal(policyMutation('GET', '/api/plugins/add'), false)
  })

  await check('the disclaimer describes the offered channels and the responsibility boundary', async () => {
    const { DISCLAIMER, DISCLAIMER_VERSION, OFFERED_RESTRICTED_CHANNELS } = await import('../src/disclaimer.js')
    assert.equal(DISCLAIMER_VERSION, 3)
    const named = OFFERED_RESTRICTED_CHANNELS.join(' ').toLowerCase()
    for (const channel of ['workbuddy', 'workbuddy-ai', 'codebuddy', 'huaweicloud', 'codearts']) {
      assert.match(named, new RegExp(channel), `the disclaimer names ${channel}`)
    }
    const body = DISCLAIMER.sections.map(section => section.body).join(' ')
    assert.match(body, /额外提供/, 'it says the branch offers them')
    assert.match(body, /与本项目作者及团队无关/, 'it states the team is not responsible')
    assert.match(body, /个人学习/, 'it states the project purpose')
    assert.match(body, /自行承担/, 'it places the consequences on the user')
  })

  const hasEngine = pinnedEngineEntry() !== null
  if (!hasEngine) {
    console.log(`ok  engine-backed groups skipped: no pinned engine binary for ${process.platform}-${process.arch}`)
  } else {
    await engine.start()
    const origin = await listen()
    const base = origin + prefix
    const read = async route => {
      const response = await fetch(base + route)
      assert.equal(response.status, 200, route)
      return response.json()
    }
    const post = async (route, body) => fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

    await check('the engine is no longer asked to refuse the formerly excluded channels', async () => {
      for (const [route, body] of [
        ['api/plugins/add', { spec: PACKAGE }],
        ['api/signin', { agent: 'workbuddy' }],
        ['api/plugin-signin', { provider: 'workbuddy-ai', method: 0 }],
        ['api/provider/move', { id: 'workbuddy' }],
        ['api/provider/save', { preset: 'codearts', key: 'fixture' }],
      ]) {
        const response = await post(route, body)
        assert.doesNotMatch(await response.text(), /not offered by this build/, route)
      }
      const page = await fetch(base + 'api/plugins/page?name=' + encodeURIComponent(PACKAGE))
      assert.doesNotMatch(await page.text(), /not offered by this build/)
    })

    await check('the formerly hidden preset reaches the provider add sheet', async () => {
      const providers = await read('api/providers')
      assert.ok(Array.isArray(providers.presets) && providers.presets.length > 5, 'presets stay')
      assert.ok(providers.presets.some(preset => preset.id === 'huaweicloud'), 'Huawei Cloud preset is offered')
      assert.ok(providers.presets.some(preset => preset.id === 'tencent-cloud'), 'other regional presets stay')
      const upstream = await read('api/upstream')
      assert.ok(Object.hasOwn(upstream.providers ?? {}, 'huaweicloud'), 'vendor status keeps the id')
      const listings = await read('api/plugins/listings')
      assert.ok(listings.listings.length > 5, 'market listings stay intact')
    })

    await check('unrelated work on the same routes still reaches the engine', async () => {
      const discovery = await post('api/settings/account-discovery', { off: true })
      assert.equal(discovery.status, 200, 'settings still writable')
      const settings = await read('api/settings')
      assert.equal(typeof settings.noAccountDiscovery, 'boolean', 'settings still answered')
      assert.equal(await notRefused('POST', '/api/plugins/add', { spec: '@ofm-absent-package' }), true)
    })
  }

  console.log(`magpie-policy: ${checks} checks passed`)
} finally {
  await engine.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(scratch, { recursive: true, force: true })
}
