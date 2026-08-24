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
  const runs = await fetch(base + '/actions/runs?per_page=6', { headers }).then((r) => r.json())
  const verify = runs.workflow_runs.find((r) => r.name === 'verify' && r.conclusion === 'failure')
  console.log('verify run:', verify.id, verify.conclusion)
  const jobs = await fetch(verify.jobs_url, { headers }).then((r) => r.json())
  for (const job of jobs.jobs) console.log('job:', job.name, '->', job.conclusion)
  const failed = jobs.jobs.find((j) => j.conclusion === 'failure')
  if (!failed) {
    console.log('(tidak ada job gagal - kemungkinan start-up failure)')
    return
  }
  const res = await fetch(base + '/actions/jobs/' + failed.id + '/logs', {
    headers,
    redirect: 'follow',
  }).then((r) => r.text())
  const lines = res.split(/\r?\n/)
  const errIdx = []
  lines.forEach((l, i) => {
    if (/##\[error\]|npm error|ELIFECYCLE|Error:/i.test(l)) errIdx.push(i)
  })
  console.log('--- konteks error ---')
  const shown = new Set()
  for (const i of errIdx.slice(-6)) {
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
      if (!shown.has(j)) {
        shown.add(j)
        console.log(lines[j].slice(0, 180))
      }
    }
  }
}
main().catch((e) => console.error(String(e).slice(0, 300)))
