import { Elysia } from 'elysia'
import { staticPlugin } from '@elysiajs/static'

const ARGOCD_URL = process.env.ARGOCD_URL ?? 'https://argocd.easy-deploy.135.181.177.246.nip.io'
const ARGOCD_PASSWORD = process.env.ARGOCD_PASSWORD ?? 'HpjXNxyHse9yjAB6'
const CLUSTER_IP = '135.181.177.246'
const INFISICAL_URL = 'https://infisical.easy-deploy.135.181.177.246.nip.io'
const GRAFANA_URL = 'https://shanzindlr.grafana.net'
const INFISICAL_ORG_ID = '058c91f2-63c4-4a9b-a58a-74855d18f167'

let argoToken: string | null = null

async function getArgoToken() {
  const res = await fetch(`${ARGOCD_URL}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ARGOCD_PASSWORD }),
  })
  const data = await res.json() as { token?: string }
  argoToken = data.token ?? null
  return argoToken
}

async function fetchApps() {
  if (!argoToken) await getArgoToken()

  const res = await fetch(`${ARGOCD_URL}/api/v1/applications?fields=items.metadata.name,items.status.health,items.status.sync`, {
    headers: { Authorization: `Bearer ${argoToken}` },
  })

  if (res.status === 401) {
    await getArgoToken()
    return fetchApps()
  }

  const data = await res.json() as { items?: any[] }

  const byBase = new Map<string, { name: string; dev?: AppEnv; prod?: AppEnv }>()

  for (const item of data.items ?? []) {
    const match = (item.metadata.name as string).match(/^(.+)-(dev|prod)$/)
    if (!match) continue
    const [, base, env] = match
    if (!byBase.has(base)) byBase.set(base, { name: base })
    byBase.get(base)![env as 'dev' | 'prod'] = {
      health: item.status?.health?.status ?? 'Unknown',
      sync: item.status?.sync?.status ?? 'Unknown',
    }
  }

  return Array.from(byBase.values()).map(app => ({
    ...app,
    links: {
      dev: `https://${app.name}-dev.easy-deploy.${CLUSTER_IP}.nip.io`,
      prod: `https://${app.name}.easy-deploy.${CLUSTER_IP}.nip.io`,
      argocd: `${ARGOCD_URL}/applications/${app.name}-dev`,
      grafana: `${GRAFANA_URL}/d/easydeploy-${app.name}/${app.name}`,
      infisical: `${INFISICAL_URL}/organizations/${INFISICAL_ORG_ID}/projects/secret-management`,
    },
  }))
}

type AppEnv = { health: string; sync: string }

new Elysia()
  .use(staticPlugin({ assets: 'public', prefix: '/' }))
  .get('/healthz', () => ({ status: 'ok' }))
  .get('/api/apps', async () => {
    try {
      return await fetchApps()
    } catch (e) {
      return { error: String(e) }
    }
  })
  .listen(3000, () => console.log('portal running on :3000'))
