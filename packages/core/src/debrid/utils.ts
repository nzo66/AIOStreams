import { ParsedFile } from '../db/schemas';
import { createLogger } from '../utils';

const logger = createLogger('debrid');

interface FileWithParsedInfo {
  name: string;
  size: number;
  index: number;
  parsed: ParsedFile;
  isVideo: boolean;
  path?: string;
  link?: string;
}

export function findMatchingFileInTorrent(
  files: FileWithParsedInfo[],
  chosenIndex?: number,
  requestedFilename?: string,
  requestedTitle?: string,
  season?: string,
  episode?: string,
  expectLinks?: boolean
): FileWithParsedInfo | null {
  for (const file of files) {
    if (!file.isVideo || file.name?.includes('sample')) {
      continue;
    }

    if (requestedFilename) {
      if (file.name === requestedFilename) {
        return file;
      }
    }

    if (season || episode) {
      if (
        (requestedTitle ? file.parsed.title === requestedTitle : true) &&
        ((season && !episode && file.parsed.season === Number(season)) ||
          (episode && !season && file.parsed.episode === Number(episode)) ||
          (season &&
            episode &&
            file.parsed.season === Number(season) &&
            file.parsed.episode === Number(episode)))
      ) {
        return file;
      }
    } else {
      if (requestedTitle) {
        if (file.parsed.title === requestedTitle) {
          return file;
        }
      }
    }
  }

  if (chosenIndex) {
    const fileIdx = files.find((file) => file.index === chosenIndex);
    if (fileIdx) return fileIdx;
  }

  if (files.length > 0 && (!expectLinks || files.some((file) => file.link))) {
    return files
      .filter((file) => !expectLinks || file.link)
      .reduce((largest, current) =>
        current.size > largest.size ? current : largest
      );
  }

  return null;
}

export function isVideoFile(filename: string): boolean {
  const videoExtensions = [
    '.3g2',
    '.3gp',
    '.amv',
    '.asf',
    '.avi',
    '.drc',
    '.f4a',
    '.f4b',
    '.f4p',
    '.f4v',
    '.flv',
    '.gif',
    '.gifv',
    '.m2v',
    '.m4p',
    '.m4v',
    '.mkv',
    '.mov',
    '.mp2',
    '.mp4',
    '.mpg',
    '.mpeg',
    '.mpv',
    '.mng',
    '.mpe',
    '.mxf',
    '.nsv',
    '.ogg',
    '.ogv',
    '.qt',
    '.rm',
    '.rmvb',
    '.roq',
    '.svi',
    '.webm',
    '.wmv',
    '.yuv',
    '.m3u8',
    '.m2ts',
  ];
  return videoExtensions.some((ext) => filename.endsWith(ext));
}
