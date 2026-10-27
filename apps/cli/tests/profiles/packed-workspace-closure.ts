/** Workspace manifests and install closures for the packed-installation rehearsal. */
const RUNTIME_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/** One workspace manifest available to the packed-install rehearsal. */
export interface WorkspacePackage {
  name: string
  directory: string
  manifest: Record<string, unknown>
}

function dependencyEntries(
  manifest: Record<string, unknown>,
  section: (typeof RUNTIME_SECTIONS)[number],
): [string, string][] {
  const value = manifest[section]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
}

function optionalPeer(manifest: Record<string, unknown>, name: string): boolean {
  const metadata = manifest.peerDependenciesMeta
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const entry = (metadata as Record<string, unknown>)[name]
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).optional === true
}

/**
 * Follow install dependencies and required peers inside one workspace.
 * @param rootName - package whose consumer closure is required.
 * @param packages - workspace packages indexed by package name.
 * @returns Transitive runtime closure sorted by package directory.
 */
export function packedWorkspaceClosure(
  rootName: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): WorkspacePackage[] {
  const closure: WorkspacePackage[] = []
  const visited = new Set<string>()
  const visit = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    const current = packages.get(name)
    if (current === undefined) throw new Error(`packed workspace closure cannot resolve ${name}`)
    closure.push(current)
    for (const section of RUNTIME_SECTIONS) {
      for (const [dependency, range] of dependencyEntries(current.manifest, section)) {
        if (!range.startsWith('workspace:')) continue
        if (section === 'peerDependencies' && optionalPeer(current.manifest, dependency)) continue
        visit(dependency)
      }
    }
  }
  visit(rootName)
  return closure.sort((left, right) => left.directory.localeCompare(right.directory))
}
