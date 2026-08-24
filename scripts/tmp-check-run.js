const { execSync } = require('child_process')

// Ask git's credential helper for the stored github.com token (same one used to push)
const raw = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n',
  encoding: 'utf8',
})
const token = raw
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice('password='.length)
if (!token) {
  console.log('tidak ada kredensial tersimpan')
  process.exit(1)
}

const headers = {
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'markforge-local',
}
const base = 'https://api.github.com/repos/ryansammm/MarkForge'

async function main() {
  const runs = await fetch(base + '/actions/runs?per_page=3', { headers }).then((r) => r.json())
  if (!runs.workflow_runs) {
    console.log('API response:', JSON.stringify(runs).slice(0, 200))
    return
  }
  for (const r of runs.workflow_runs) {
    console.log(`run: ${r.name} | ${r.display_title} | ${r.status} | ${r.conclusion ?? '-'}`)
  }

  const latest = runs.workflow_runs[0]
  if (latest.status !== 'completed') {
    console.log('masih berjalan - cek lagi beberapa menit')
    return
  }
  if (latest.conclusion === 'success') {
    const rel = await fetch(base + '/releases/latest', { headers }).then((r) => {
      if (r.status === 404) return null
      return r.json()
    })
    if (rel) {
      console.log('RELEASE:', rel.name || rel.tag_name)
      for (const a of rel.assets) console.log('  asset:', a.name, Math.round(a.size / 1024 / 1024) + ' MB')
    } else {
      console.log('belum ada release')
    }
    return
  }

  // Failed -> find the failed step inside the job
  const jobs = await fetch(latest.jobs_url, { headers }).then((r) => r.json())
  for (const job of jobs.jobs) {
    console.log('job:', job.name, '->', job.conclusion)
    for (const step of job.steps) {
      if (step.conclusion === 'failure') console.log('  STEP GAGAL:', step.name)
    }
    if (job.conclusion === 'failure') {
      const logRes = await fetch(job.url + '/logs', {
        headers,
        redirect: 'follow',
      })
      if (logRes.ok) {
        const text = await logRes.text()
        const lines = text.split(/\r?\n/).filter((l) => /##\[error\]|Error:|npm error/i.test(l))
        console.log(lines.slice(-12).join('\n').slice(0, 2500))
      } else {
        console.log('(log tidak bisa dibaca:', logRes.status, ')')
      }
    }
  }
}

main().catch((e) => console.error('ERR', String(e).slice(0, 200)))
