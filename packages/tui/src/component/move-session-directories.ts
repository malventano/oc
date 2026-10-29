import path from "path"

export type MoveSessionDirectoryRoot = {
  directory: string
}

export type MoveSessionSubdirectory<T extends MoveSessionDirectoryRoot> = {
  location: string
  root: T
}

export function contains(root: string, directory: string) {
  if (root === directory) return true
  const relative = path.relative(root, directory)
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

export function mergeMoveSessionSubdirectories<T extends MoveSessionDirectoryRoot>(input: {
  roots: readonly T[]
  sessions: readonly string[]
  children: readonly string[]
}): MoveSessionSubdirectory<T>[] {
  const roots = input.roots
  const candidates = [...input.sessions, ...input.children]
    .filter((directory) => !roots.some((root) => root.directory === directory))
    .filter((directory, index, directories) => directories.indexOf(directory) === index)

  return candidates
    .map((location) => ({
      location,
      root: roots
        .filter((root) => {
          const relative = path.relative(root.directory, location)
          return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
        })
        .toSorted((a, b) => b.directory.length - a.directory.length)[0],
    }))
    .filter((item): item is MoveSessionSubdirectory<T> => item.root !== undefined)
}
