const fs = require('fs')
const text = fs.readFileSync('ci-build-section.log', 'utf8')
void text
const { execSync } = require('child_process')

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
  const jobs = await fetch(run.jobs_url, { headers }).then((r) => r.json())
  const res = await fetch(base + '/actions/jobs/' + jobs.jobs[0].id + '/logs', {
    headers,
    redirect: 'follow',
  }).then((r) => r.text())
  const lines = res.split(/\r?\n/)
  const failIdx = lines.findIndex((l) => l.includes('step failed'))
  console.log('total lines:', lines.length, '| fail at:', failIdx)
  console.log(lines.slice(Math.max(0, failIdx - 35), failIdx + 3).join('\n').slice(0, 5000))
}

main().catch((e) => console.error(String(e).slice(0, 300)))
