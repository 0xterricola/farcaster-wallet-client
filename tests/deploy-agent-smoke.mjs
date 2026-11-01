#!/usr/bin/env node
// Smoke test for the deploy-agent: does a job actually RUN, and does it
// SURVIVE a restart?
//
// Why this exists: the agent's gates (lint/typecheck/test on farcaster-web)
// never execute services/deploy-agent/server.mjs, so a job whose first
// statement threw at runtime shipped green. The bug that motivated this file
// was automatic semicolon insertion turning
//   job.state = 'running'
//   (async () => { … })()
// into `'running'(…)()` — `TypeError: "running" is not a function` on every
// provision, while every gate passed.
//
// It is hermetic on purpose: the repo is a temp dir with stub scripts, so
// nothing here touches AWS, SSH or the network. Run: node tests/deploy-agent-smoke.mjs
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'services', 'deploy-agent', 'server.mjs')
const TOKEN = 'smoke-token'
const FID = 191554

let checks = 0
let failures = 0
const ok = (name, pass, extra = '') => {
  checks += 1
  if (pass) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'fiddy-agent-smoke-'))
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  const jobsDir = join(home, '.fiddy', 'jobs')
  await mkdir(join(repo, 'bin'), { recursive: true })
  await mkdir(join(repo, 'scripts'), { recursive: true })
  await mkdir(home, { recursive: true })

  // The CLI stand-in: records the facts a real `fiddy provision --aws` would
  // write to $FIDDY_HOME/config, and prints a line a human could read. It also
  // creates the pem it names — the agent's retry source check verifies the key
  // file really exists before reusing a job home.
  const cli = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\${FIDDY_HOME}"
touch "\${FIDDY_HOME}/fiddy-node.pem"; chmod 600 "\${FIDDY_HOME}/fiddy-node.pem"
cat >> "\${FIDDY_HOME}/config" <<'FACTS'
FIDDY_PROVIDER=aws
FIDDY_TARGET=ubuntu@203.0.113.7
FIDDY_AWS_INSTANCE_ID=i-0smoke0000000001
FIDDY_AWS_VOLUME_ID=vol-0smoke00000001
FIDDY_AWS_SG_ID=sg-0smoke00000001
FIDDY_AWS_KEY_NAME=fiddy-node
FIDDY_AWS_IP=203.0.113.7
FIDDY_AWS_REGION=us-east-1
FIDDY_NODE_NETWORK=snapchain
FACTS
# The real CLI records the key path IT wrote, which is derived from FIDDY_HOME —
# so a job home of "undefined/.fiddy/…" shows up here as a relative path.
echo "FIDDY_SSH_KEY=\${FIDDY_HOME}/fiddy-node.pem" >> "\${FIDDY_HOME}/config"
echo "stub fiddy: \$* (job home \$FIDDY_HOME)"
`
  const terminal = `#!/usr/bin/env bash
set -euo pipefail
echo "stub terminal install: \$*"
echo 'FIDDY_TERMINAL_JSON {"fid":${FID},"terminalUrl":"https://fiddy.fun/term/deadbeef/","endpointUrl":"https://fiddy.fun/node/deadbeef/","unitState":"active","terminalHttp":"200","nodeApiHttp":"000","sshReachable":true,"nodeLocalConfig":true}'
`
  const teardown = `#!/usr/bin/env bash
set -euo pipefail
echo "stub teardown: \$*"
echo 'FIDDY_TEARDOWN_JSON {"instanceId":"i-0smoke0000000001","region":"us-east-1","state":"terminated","billingStopped":true}'
`
  await writeFile(join(repo, 'bin', 'fiddy'), cli)
  await writeFile(join(repo, 'scripts', 'install-node-terminal.sh'), terminal)
  await writeFile(join(repo, 'scripts', 'aws-teardown.sh'), teardown)
  await chmod(join(repo, 'bin', 'fiddy'), 0o755)
  // Deliberately NOT executable: the deployed checkout's mode bit is not the
  // agent's to control (it was committed 644 once and the terminal install died
  // with EACCES after the node was already running and billing). The agent runs
  // repo scripts through bash, so a 644 script must still install.
  await chmod(join(repo, 'scripts', 'install-node-terminal.sh'), 0o644)
  await chmod(join(repo, 'scripts', 'aws-teardown.sh'), 0o644)

  const port = await freePort()
  const spawnServer = () =>
    spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        DEPLOY_AGENT_TOKEN: TOKEN,
        FIDDY_REPO: repo,
        HOME: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  let child = spawnServer()
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })
  const base = `http://127.0.0.1:${port}`
  const authed = (init = {}) => ({
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  })

  try {
    // --- the server comes up ------------------------------------------------
    let health = null
    for (let i = 0; i < 50 && !health; i += 1) {
      try {
        const r = await fetch(`${base}/health`)
        if (r.ok) health = await r.json()
      } catch {
        await sleep(100)
      }
    }
    ok('the agent answers /health without a token', health?.ok === true, `stderr: ${stderr.slice(-200)}`)

    // --- auth is a wall ----------------------------------------------------
    const noAuth = await fetch(`${base}/status/whatever`)
    ok('an unauthenticated /status is 401', noAuth.status === 401, `got ${noAuth.status}`)
    const noAuthProvision = await fetch(`${base}/provision`, { method: 'POST', body: '{}' })
    ok('an unauthenticated /provision is 401', noAuthProvision.status === 401, `got ${noAuthProvision.status}`)

    // --- a job RUNS (the regression this file guards) ----------------------
    // Wrapped, because the failure this guards against kills the agent mid-
    // request: the socket closes and an unhandled fetch error would bury the
    // diagnosis the checks below produce.
    let started = null
    let startedBody = null
    try {
      started = await fetch(
        `${base}/provision`,
        authed({ method: 'POST', body: JSON.stringify({ kind: 'aws', fid: FID, token: 'a'.repeat(64) }) }),
      )
      startedBody = await started.json().catch(() => null)
    } catch (error) {
      startedBody = { error: String(error?.cause ?? error) }
    }
    ok('POST /provision answers 202 with a jobId', started?.status === 202 && typeof startedBody?.jobId === 'string', `status ${started?.status}, body ${JSON.stringify(startedBody)}`)
    ok('the agent process is still alive after a job starts', child.exitCode === null, `exit ${child.exitCode}; stderr: ${stderr.slice(-300)}`)

    let job = null
    if (typeof startedBody?.jobId === 'string') {
      // The terminal install is chained INSIDE the same job (a 2s tick after the
      // provision reports done), so "done" alone is not the finish line when a
      // terminal was requested: wait for the terminal verdict.
      for (let i = 0; i < 160; i += 1) {
        const r = await fetch(`${base}/status/${startedBody.jobId}`, authed())
        job = await r.json().catch(() => null)
        if (job?.state === 'failed') break
        if (job && job.terminal) break
        await sleep(150)
      }
    }
    ok('the job reaches done', job?.state === 'done', `state ${job?.state}, step ${job?.step}, tail ${(job?.logTail ?? '').slice(-300)}`)
    ok('the provision step really ran', (job?.logTail ?? '').includes('stub fiddy: provision --aws'))
    ok('the node-up step really ran', (job?.logTail ?? '').includes('stub fiddy: node up'))
    ok('the terminal install is chained behind the provision', (job?.logTail ?? '').includes('stub terminal install: --fid'))
    ok('a 644 script still installs (the agent runs repo scripts through bash)', (job?.logTail ?? '').includes('stub terminal install: --fid'), 'the install never ran: EACCES?')
    ok('the instance id is read back from facts, not scraped', job?.facts?.instanceId === 'i-0smoke0000000001', JSON.stringify(job?.facts))
    ok('the job home comes from HOME, not the string "undefined"', (job?.logTail ?? '').includes(`job home ${home}/.fiddy/jobs/`), `keyPath ${job?.facts?.keyPath}`)
    ok('the node key path is absolute', typeof job?.facts?.keyPath === 'string' && job.facts.keyPath.startsWith('/'), String(job?.facts?.keyPath))
    ok('the terminal verdict is parsed', job?.terminal?.terminalUrl === 'https://fiddy.fun/term/deadbeef/', JSON.stringify(job?.terminal))

    // --- the job is PERSISTED (a restart must not strand it) ---------------
    const jobId = startedBody?.jobId
    let persisted = null
    if (typeof jobId === 'string') {
      try {
        persisted = JSON.parse(await readFile(join(jobsDir, jobId, 'job.json'), 'utf8'))
      } catch {
        persisted = null
      }
    }
    ok('the job record is persisted to job.json', persisted?.state === 'done' && persisted?.facts?.instanceId === 'i-0smoke0000000001', JSON.stringify(persisted)?.slice(0, 200))
    ok('the persisted record keeps the fid (a retry is found by it)', persisted?.fid === FID, String(persisted?.fid))

    // A job that was mid-flight at death: planted before the restart.
    const ghostId = 'ghost-job-0001'
    await mkdir(join(jobsDir, ghostId), { recursive: true })
    await writeFile(join(jobsDir, ghostId, 'job.json'), JSON.stringify({
      id: ghostId, kind: 'provision-aws', fid: null, state: 'running', step: 'fiddy node up',
      facts: { instanceId: 'i-0smokeghost00001', target: 'ubuntu@203.0.113.9', keyPath: join(jobsDir, ghostId, 'k.pem') },
      startedAt: Date.now() - 60_000, updatedAt: Date.now() - 1000, home: join(jobsDir, ghostId), log: 'mid-flight',
    }))

    // --- RESTART the agent --------------------------------------------------
    child.kill('SIGKILL')
    child = spawnServer()
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    let health2 = null
    for (let i = 0; i < 50 && !health2; i += 1) {
      try {
        const r = await fetch(`${base}/health`)
        if (r.ok) health2 = await r.json()
      } catch {
        await sleep(100)
      }
    }
    ok('the agent restarts and answers /health', health2?.ok === true, `stderr: ${stderr.slice(-200)}`)

    let recalled = null
    if (typeof jobId === 'string') {
      const r = await fetch(`${base}/status/${jobId}`, authed())
      recalled = r.status === 200 ? await r.json() : null
    }
    ok('a finished job is still answerable after a restart (facts intact)', recalled?.state === 'done' && recalled?.facts?.instanceId === 'i-0smoke0000000001', `state ${recalled?.state}, facts ${JSON.stringify(recalled?.facts ?? {})}`)

    let ghost = null
    {
      const r = await fetch(`${base}/status/${ghostId}`, authed())
      ghost = r.status === 200 ? await r.json() : null
    }
    ok('a job that was running at death is marked failed, not forgotten', ghost?.state === 'failed' && ghost?.facts?.instanceId === 'i-0smokeghost00001', `state ${ghost?.state}, facts ${JSON.stringify(ghost?.facts ?? {})}`)
    ok('the interrupted job says WHY it failed', (ghost?.logTail ?? '').includes('agent restarted'), (ghost?.logTail ?? '').slice(-200))

    // --- RETRY IN PLACE: same instance, no provision step -------------------
    let retryStarted = null
    let retryBody = null
    try {
      retryStarted = await fetch(`${base}/retry`, authed({ method: 'POST', body: JSON.stringify({ fid: FID, token: 'b'.repeat(64) }) }))
      retryBody = await retryStarted.json().catch(() => null)
    } catch (error) {
      retryBody = { error: String(error?.cause ?? error) }
    }
    ok('POST /retry answers 202 with a jobId', retryStarted?.status === 202 && typeof retryBody?.jobId === 'string', `status ${retryStarted?.status}, body ${JSON.stringify(retryBody)}`)

    let retryJob = null
    if (typeof retryBody?.jobId === 'string') {
      for (let i = 0; i < 160; i += 1) {
        const r = await fetch(`${base}/status/${retryBody.jobId}`, authed())
        retryJob = await r.json().catch(() => null)
        if (retryJob?.state === 'failed') break
        if (retryJob && retryJob.terminal) break
        await sleep(150)
      }
    }
    ok('the retry job reaches done with a terminal', retryJob?.state === 'done' && retryJob?.terminal != null, `state ${retryJob?.state}, tail ${(retryJob?.logTail ?? '').slice(-300)}`)
    ok('the retry re-runs node up WITHOUT a provision step', (retryJob?.logTail ?? '').includes('stub fiddy: node up') && !(retryJob?.logTail ?? '').includes('stub fiddy: provision'), (retryJob?.logTail ?? '').slice(-200))
    ok('the retry says which target it reused', (retryJob?.logTail ?? '').includes('retrying in place against ubuntu@203.0.113.7'), (retryJob?.logTail ?? '').slice(-300))
    ok('the retry keeps the recorded instance id', retryJob?.facts?.instanceId === 'i-0smoke0000000001', JSON.stringify(retryJob?.facts ?? {}))
    if (typeof retryBody?.jobId === 'string' && typeof jobId === 'string') {
      ok('the retry is a NEW job, not a rewrite of the old one', retryBody.jobId !== jobId)
    }
    const unknownFid = await fetch(`${base}/retry`, authed({ method: 'POST', body: JSON.stringify({ fid: 999999 }) }))
    ok('a retry with no recorded target/key is refused (400)', unknownFid.status === 400, `got ${unknownFid.status}`)

    // --- TEARDOWN carries the fid (terminal removal is part of it) ----------
    let teardownStarted = null
    let teardownBody = null
    try {
      teardownStarted = await fetch(`${base}/teardown`, authed({ method: 'POST', body: JSON.stringify({ instanceId: 'i-0abc0def01234567', fid: FID }) }))
      teardownBody = await teardownStarted.json().catch(() => null)
    } catch (error) {
      teardownBody = { error: String(error?.cause ?? error) }
    }
    ok('POST /teardown with a fid answers 202', teardownStarted?.status === 202 && typeof teardownBody?.jobId === 'string', `status ${teardownStarted?.status}, body ${JSON.stringify(teardownBody)}`)
    let teardownJob = null
    if (typeof teardownBody?.jobId === 'string') {
      for (let i = 0; i < 120; i += 1) {
        const r = await fetch(`${base}/status/${teardownBody.jobId}`, authed())
        teardownJob = await r.json().catch(() => null)
        if (teardownJob?.state === 'failed' || teardownJob?.teardown) break
        await sleep(150)
      }
    }
    ok('the teardown job passes --fid to the script', (teardownJob?.logTail ?? '').includes(`--fid ${FID}`), (teardownJob?.logTail ?? '').slice(-200))
    ok('the teardown verdict is parsed', teardownJob?.teardown?.billingStopped === true, JSON.stringify(teardownJob?.teardown))
  } finally {
    child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
