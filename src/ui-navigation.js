export const viewIds = Object.freeze(['reports', 'checkpoints', 'todos'])

export function viewFromHash(hash) {
  const view = hash.startsWith('#') ? hash.slice(1) : hash
  return viewIds.includes(view) ? view : viewIds[0]
}

export function watchHashView(target, onChange) {
  const sync = () => onChange(viewFromHash(target.location.hash))
  target.addEventListener('hashchange', sync)
  sync()
  return () => target.removeEventListener('hashchange', sync)
}
