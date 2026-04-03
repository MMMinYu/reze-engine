import { normalizeAssetPath } from "./asset-reader"

/**
 * Call on `<input type="file" webkitdirectory>` `change` **before** `input.value = ""`.
 * `FileList` is live — clearing the input empties it; this copies to a stable `File[]`.
 */
function prepareLocalFolderFiles(fileList: FileList | null | undefined): {
  files: File[]
  pmxRelativePaths: string[]
} {
  const files = fileList?.length ? Array.from(fileList) : []
  const pmxRelativePaths: string[] = []
  for (const f of files) {
    const wr = (f as File & { webkitRelativePath?: string }).webkitRelativePath
    if (!wr || !wr.toLowerCase().endsWith(".pmx")) continue
    pmxRelativePaths.push(normalizeAssetPath(wr))
  }
  pmxRelativePaths.sort((a, b) => a.localeCompare(b))
  return { files, pmxRelativePaths }
}

function isDirectoryUpload(files: File[]): boolean {
  return files.length > 0 && files.every((f) => !!(f as File & { webkitRelativePath?: string }).webkitRelativePath)
}

/** After choosing a path from `multiple`, get the `File` for `loadModel(..., { files, pmxFile })`. */
export function pmxFileAtRelativePath(files: File[], relativePath: string): File | undefined {
  const norm = normalizeAssetPath(relativePath)
  for (const f of files) {
    const wr = (f as File & { webkitRelativePath?: string }).webkitRelativePath
    if (wr && normalizeAssetPath(wr) === norm) return f
  }
  return undefined
}

/** Result of reading a folder input — switch on `status` in your UI. */
export type PmxFolderInputResult =
  | { status: "empty" }
  | { status: "not_directory" }
  | { status: "no_pmx" }
  | { status: "single"; files: File[]; pmxFile: File }
  | { status: "multiple"; files: File[]; pmxRelativePaths: string[] }

/**
 * One call from `onChange`: snapshots files, validates folder pick, resolves a single PMX or asks you to pick among several.
 * Reset the input after: `e.target.value = ""`.
 */
export function parsePmxFolderInput(fileList: FileList | null | undefined): PmxFolderInputResult {
  const { files, pmxRelativePaths } = prepareLocalFolderFiles(fileList)
  if (files.length === 0) return { status: "empty" }
  if (!isDirectoryUpload(files)) return { status: "not_directory" }
  if (pmxRelativePaths.length === 0) return { status: "no_pmx" }
  if (pmxRelativePaths.length === 1) {
    const pmxFile = pmxFileAtRelativePath(files, pmxRelativePaths[0]!)
    if (!pmxFile) return { status: "no_pmx" }
    return { status: "single", files, pmxFile }
  }
  return { status: "multiple", files, pmxRelativePaths }
}
