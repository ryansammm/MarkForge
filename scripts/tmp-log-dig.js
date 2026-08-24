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
  const runs = await fetch(base + '/actions/runs?per_page=3', { headers }).then((r) => r.json())
  const run = runs.workflow_runs.find((r) => r.name === 'release')
  console.log('run:', run.id, run.status, run.conclusion)
  const jobs = await fetch(run.jobs_url, { headers }).then((r) => r.json())
  const job = jobs.jobs[0]
  const res = await fetch(base + '/actions/jobs/' + job.id + '/logs', {
    headers,
    redirect: 'follow',
  })
  const text = await res.text()
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes('Build portable exe'))
  const section = lines.slice(start >= 0 ? start : 0)
  // Cetak semua baris yang menyebut jalur/error/kata kunci penting
  const interesting = section.filter(
    (l) =>
      /standalone|electron-build|ENOENT|EPERM|Error|error TS|\.next|prepare|BUILD_FOR/i.test(l) &&
      !l.includes('##[group]')
  )
  console.log(interesting.slice(0, 40).join('\n'))
}
main().catch((e) => console.error(String(e).slice(0, 300)))
