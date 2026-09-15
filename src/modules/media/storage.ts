import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { env } from '../../config/env'
import { logger } from '../../config/logger'

/**
 * Media storage.
 *
 * Everything goes through this interface so switching from local disk to S3 or
 * Cloudinary later is an implementation swap rather than a refactor of every
 * upload handler. Only the local driver is wired up, which is what running
 * entirely on your own machine requires.
 */

export const MEDIA_FOLDERS = [
  'products',
  'banners',
  'blog',
  'categories',
  'collections',
  'editorial',
  'general',
] as const

export type MediaFolder = (typeof MEDIA_FOLDERS)[number]

export interface StoredFile {
  filename: string
  url: string
  thumbnailUrl: string | null
  folder: string
  size: number
  width: number | null
  height: number | null
  mimeType: string
}

const uploadRoot = () => path.resolve(process.cwd(), env.UPLOAD_DIR)

export async function ensureUploadDirs(): Promise<void> {
  const root = uploadRoot()
  await fs.mkdir(root, { recursive: true })
  await Promise.all(
    MEDIA_FOLDERS.map((folder) =>
      fs.mkdir(path.join(root, folder), { recursive: true }),
    ),
  )
  await fs.mkdir(path.join(root, 'thumbnails'), { recursive: true })
  logger.debug(`Upload directories ready at ${root}`)
}

function safeFolder(folder: string): MediaFolder {
  return (MEDIA_FOLDERS as readonly string[]).includes(folder)
    ? (folder as MediaFolder)
    : 'general'
}

/**
 * Filenames are content-addressed rather than taken from the upload.
 *
 * A user-supplied name is an injection vector (`../../.env`) and a collision
 * risk. A random stem sidesteps both, and the original name is preserved in the
 * media_assets row for display.
 */
function buildFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().slice(0, 10)
  const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : ''
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`
}

const RASTER_MIME = /^image\/(jpeg|png|webp|avif|gif)$/

export async function storeFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  folder: string,
): Promise<StoredFile> {
  const targetFolder = safeFolder(folder)
  const filename = buildFilename(originalName)
  const destination = path.join(uploadRoot(), targetFolder, filename)

  let width: number | null = null
  let height: number | null = null
  let thumbnailUrl: string | null = null
  let finalBuffer = buffer

  if (RASTER_MIME.test(mimeType)) {
    try {
      const image = sharp(buffer, { animated: mimeType === 'image/gif' })
      const metadata = await image.metadata()
      width = metadata.width ?? null
      height = metadata.height ?? null

      // Cap absurd source files. 2400px wide is ample for a full-bleed banner
      // and keeps the storefront's next/image work cheap.
      if ((metadata.width ?? 0) > 2400) {
        finalBuffer = await image.resize({ width: 2400, withoutEnlargement: true }).toBuffer()
        const resized = await sharp(finalBuffer).metadata()
        width = resized.width ?? width
        height = resized.height ?? height
      }

      const thumbName = `thumb-${filename.replace(/\.[^.]+$/, '')}.webp`
      await sharp(buffer)
        .resize({ width: 400, height: 500, fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(path.join(uploadRoot(), 'thumbnails', thumbName))

      thumbnailUrl = `${env.API_BASE_URL}/uploads/thumbnails/${thumbName}`
    } catch (error) {
      // A corrupt or unusual image should not fail the upload outright; it is
      // stored as-is and simply gets no dimensions or thumbnail.
      logger.warn({ err: error, originalName }, 'Image processing failed; storing original')
    }
  }

  await fs.writeFile(destination, finalBuffer)

  return {
    filename,
    url: `${env.API_BASE_URL}/uploads/${targetFolder}/${filename}`,
    thumbnailUrl,
    folder: targetFolder,
    size: finalBuffer.byteLength,
    width,
    height,
    mimeType,
  }
}

export async function deleteFile(url: string): Promise<void> {
  try {
    const relative = url.replace(`${env.API_BASE_URL}/uploads/`, '')
    // Never let a stored URL escape the upload root.
    const resolved = path.resolve(uploadRoot(), relative)
    if (!resolved.startsWith(uploadRoot())) {
      logger.warn({ url }, 'Refused to delete a file outside the upload root')
      return
    }
    await fs.unlink(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: error, url }, 'Failed to delete media file')
    }
  }
}
