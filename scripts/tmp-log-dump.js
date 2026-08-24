const { execSync } = require('child_process')
const fs = require('fs')

const raw = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n',
  encoding: 'utf8',
})
const token = raw
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice('password='.length)

const headers = {
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'markforge-local',
}
const base = 'https://api.github.com/repos/ryansammm/MarkForge'

async function main() {
  const runs = await fetch(base + '/actions/runs?per_page=5', { headers }).then((r) => r.json())
  const run = runs.workflow_runs.find((r) => r.name === 'release')
  console.log('run:', run.id, run.status, run.conclusion)
  const jobs = await fetch(run.jobs_url, { headers }).then((r) => r.json())
  const text = await fetch(base + '/actions/jobs/' + jobs.jobs[0].id + '/logs', {
    headers,
    redirect: 'follow',
  }).then((r) => r.text())
  const lines = text.split(/\r?\n/)
  const s = lines.findIndex((l) => l.includes('Build portable exe'))
  const section = lines.slice(s >= 0 ? s : 0, (s >= 0 ? s : 0) + 100)
  fs.writeFileSync('ci-build-section.log', section.join('\n'))
  console.log('written ci-build-section.log, lines:', section.length)
}

main().catch((e) => console.error(String(e).slice(0, 300)))
