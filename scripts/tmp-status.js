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
  for (const r of runs.workflow_runs) {
    console.log(`${r.name} | ${r.head_sha.slice(0, 7)} | ${r.status} | ${r.conclusion ?? '-'}`)
  }
}
main().catch((e) => console.error(String(e).slice(0, 200)))
