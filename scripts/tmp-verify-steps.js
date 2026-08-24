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
  const runs = await fetch(base + '/actions/runs?per_page=6', { headers }).then((r) => r.json())
  const verify = runs.workflow_runs.find((r) => r.name === 'verify' && r.conclusion === 'failure')
  const jobs = await fetch(verify.jobs_url, { headers }).then((r) => r.json())
  const failed = jobs.jobs.find((j) => j.conclusion === 'failure')
  console.log('failed job:', failed.name, failed.id)
  // daftar step + kesimpulannya
  for (const st of failed.steps) {
    console.log(`  [${st.conclusion ?? '-'}] ${st.name}`)
  }
  const res = await fetch(base + '/actions/jobs/' + failed.id + '/logs', {
    headers,
    redirect: 'follow',
  }).then((r) => r.text())
  fs.writeFileSync('verify-log.txt', res)
  const lines = res.split(/\r?\n/)
  const i = lines.findIndex((l) => l.includes('npm error'))
  console.log('--- 25 baris sebelum npm error pertama ---')
  if (i >= 0) console.log(lines.slice(Math.max(0, i - 25), i + 3).join('\n').slice(0, 3000))
}
main().catch((e) => console.error(String(e).slice(0, 200)))
