export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (m, k) => {
    let v: unknown = vars
    for (const part of k.split('.')) {
      if (v && typeof v === 'object') v = (v as Record<string, unknown>)[part]
      else return m
    }
    return v == null ? m : String(v)
  })
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function renderTitle(template: string, d: Date): string {
  return template
    .replace(/%B/g, d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }))
    .replace(/%b/g, d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }))
    .replace(/%Y/g, String(d.getUTCFullYear()))
    .replace(/%y/g, String(d.getUTCFullYear()).slice(-2))
    .replace(/%m/g, pad2(d.getUTCMonth() + 1))
    .replace(/%d/g, pad2(d.getUTCDate()))
}
