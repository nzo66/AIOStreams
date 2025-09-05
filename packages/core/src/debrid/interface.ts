import { StremThru, StremThruError } from 'stremthru';
import { constants, Env, ServiceId, createLogger, Cache } from '../utils';
import { TorboxApi } from '@torbox/torbox-api';
import { z } from 'zod';
import { FileParser } from '../parser';
import { findMatchingFileInTorrent, isVideoFile } from './utils';
import { title } from 'process';

const logger = createLogger('debrid');

export type DebridErrorCode = 'NO_MATCHING_FILE';
export class DebridError extends Error {
  constructor(
    message: string,
    public readonly code: DebridErrorCode
  ) {
    super(message);
  }
}

interface UsenetDownload {
  usenetDownloadId: number;
  authId?: string;
  hash?: string;
  name?: string;
  status: 'downloaded' | 'downloading' | 'queued';
  files: {
    id?: number;
    size?: number;
    mimeType?: string;
    name?: string;
  }[];
}

export const getProvider = (
  storeName: ServiceId,
  storeCredential: string,
  clientIp?: string
): StremThru => {
  return new StremThru({
    baseUrl: Env.BUILTIN_STREMTHRU_URL,
    userAgent: Env.DEFAULT_USER_AGENT,
    auth: {
      store: storeName,
      token: storeCredential,
    },
    clientIp,
    timeout: 20000,
  });
};

type StoreAuth = {
  storeName: ServiceId;
  storeCredential: string;
};

export const StoreAuthSchema = z.object({
  storeName: z.enum(constants.SERVICES),
  storeCredential: z.string(),
});

const TorrentPlaybackInfoSchema = z.object({
  parsedId: z.object({
    id: z.string(),
    type: z.string(),
    season: z.string().optional(),
    episode: z.string().optional(),
    absoluteEpisode: z.string().optional(),
  }),
  type: z.literal('torrent'),
  hash: z.string(),
  title: z.string().optional(),
  magnet: z.string().optional(),
  index: z.number().optional(),
});

const UsenetPlaybackInfoSchema = z.object({
  type: z.literal('usenet'),
  title: z.string().optional(),
  nzb: z.string(),
});

export const PlaybackInfoSchema = z.discriminatedUnion('type', [
  TorrentPlaybackInfoSchema,
  UsenetPlaybackInfoSchema,
]);

type PlaybackInfo = z.infer<typeof PlaybackInfoSchema>;

export class DebridInterface {
  private readonly stremthru: StremThru;
  private readonly torboxApi: TorboxApi | undefined;
  private static playbackLinkCache = Cache.getInstance<string, string>(
    'debrid-link'
  );

  constructor(
    private readonly storeAuth: StoreAuth,
    private readonly clientIp?: string
  ) {
    const { storeName, storeCredential } = storeAuth;
    this.stremthru = getProvider(storeName, storeCredential, clientIp);
    if (storeName === 'torbox') {
      this.torboxApi = new TorboxApi({
        token: storeCredential,
      });
    }
  }

  public async checkMagnets(magnets: string[], sid?: string) {
    return await this.stremthru.store.checkMagnet({
      magnet: magnets,
      sid,
    });
  }

  public async resolve(
    playbackInfo: PlaybackInfo,
    filename: string
  ): Promise<string | undefined> {
    if (playbackInfo.type === 'torrent') {
      logger.debug(`Resolving torrent ${playbackInfo.hash}`);
      return await this.resolveTorrent(playbackInfo, filename);
    } else {
      logger.debug(`Resolving usenet ${playbackInfo.nzb}`);
      return await this.resolveUsenet(playbackInfo, filename);
    }
  }

  private async resolveTorrent(
    playbackInfo: PlaybackInfo & { type: 'torrent' },
    filename: string
  ): Promise<string | undefined> {
    let { hash, index, parsedId } = playbackInfo;
    const cacheKey = `${this.storeAuth.storeName}:${hash}:${index ?? 'undefined'}:${this.storeAuth.storeCredential}:${this.clientIp}`;
    const cachedLink = await DebridInterface.playbackLinkCache.get(cacheKey);
    if (cachedLink) {
      logger.debug(`Using cached link for ${hash}`);
      return cachedLink;
    }
    if (index === -1) {
      index = undefined;
    }

    logger.debug(
      `Adding magnet to ${this.storeAuth.storeName} for ${playbackInfo.magnet || `magnet:?xt=urn:btih:${hash}`}`
    );
    const magnet = await this.stremthru.store.addMagnet({
      magnet: playbackInfo.magnet || `magnet:?xt=urn:btih:${hash}`,
    });

    if (magnet.data.status !== 'downloaded') {
      return undefined;
    }

    // parse files first
    const files = magnet.data.files.map((file) => {
      return {
        parsed: FileParser.parse(file.name),
        isVideo: isVideoFile(file.name),
        index: file.index,
        name: file.name,
        size: file.size,
        link: file.link,
        path: file.path,
      };
    });

    const file = findMatchingFileInTorrent(
      files,
      index,
      filename,
      undefined,
      parsedId.season,
      parsedId.episode,
      parsedId.absoluteEpisode,
      true
    );

    if (!file || !file.link) {
      throw new DebridError('No matching file found', 'NO_MATCHING_FILE');
    }

    logger.debug(`Found matching file`, {
      season: parsedId.season,
      episode: parsedId.episode,
      absoluteEpisode: parsedId.absoluteEpisode,
      chosenFile: file.name,
      availableFiles: `[${files.map((file) => file.name).join(', ')}]`,
    });

    const link = await this.stremthru.store.generateLink({
      link: file.link,
      clientIp: this.clientIp,
    });

    const playbackLink = link.data.link;
    await DebridInterface.playbackLinkCache.set(
      cacheKey,
      playbackLink,
      60 * 30
    );
    return playbackLink;
  }

  private async resolveUsenet(
    playbackInfo: PlaybackInfo & { type: 'usenet' },
    filename: string
  ): Promise<string | undefined> {
    const { nzb } = playbackInfo;
    const cacheKey = `${this.storeAuth.storeName}:${this.storeAuth.storeCredential}:${nzb}:${this.clientIp}`;
    const cachedLink = await DebridInterface.playbackLinkCache.get(cacheKey);
    if (cachedLink) {
      logger.debug(`Using cached link for ${nzb}`);
      return cachedLink;
    }

    if (!this.torboxApi) {
      throw new Error('Torbox API not available');
    }

    const usenetDownload = await this.addUsenetDownload({
      link: nzb,
      name: filename,
    });

    if (!usenetDownload || usenetDownload.status !== 'downloaded') {
      return undefined;
    }

    if (!usenetDownload.files.length) {
      throw new Error('No files found for usenet download');
    }
    let fileId: number | undefined;
    if (usenetDownload.files.length > 1) {
      const files = usenetDownload.files.map((file) => {
        return {
          parsed: FileParser.parse(file.name ?? ''),
          isVideo:
            file.mimeType?.includes('video') || isVideoFile(file.name ?? ''),
          index: file.id ?? 0,
          name: file.name ?? '',
          size: file.size ?? 0,
        };
      });

      const file = findMatchingFileInTorrent(files);

      if (!file) {
        throw new Error('No matching file found');
      }

      logger.debug(`Found matching file`, {
        chosenFile: file.name,
        chosenIndex: file.index,
        availableFiles: `[${files.map((file) => file.name).join(', ')}]`,
      });
      fileId = file.index;
    }

    const link = await this.torboxApi.usenet.requestDownloadLink('v1', {
      usenetId: usenetDownload.usenetDownloadId.toString(),
      fileId: fileId ? fileId.toString() : undefined,
      userIp: this.clientIp,
      redirect: 'false',
      token: this.storeAuth.storeCredential,
    });

    logger.debug(
      `Requested usenet download link for ${nzb}: ${link.data?.data} ${link.metadata.status}`
    );

    const playbackLink = link.data?.data;
    if (playbackLink) {
      await DebridInterface.playbackLinkCache.set(
        cacheKey,
        playbackLink,
        60 * 30
      );
    }
    return playbackLink;
  }

  private async addUsenetDownload(params: {
    link: string;
    name: string;
  }): Promise<UsenetDownload | undefined> {
    if (!this.torboxApi) {
      throw new Error('Torbox API not available');
    }

    const { link, name } = params;
    const res = await this.torboxApi.usenet.createUsenetDownload('v1', {
      link,
      name,
    });

    if (!res.data?.data?.usenetdownloadId) {
      throw new Error(`Usenet download failed: ${res.data?.detail}`);
    }
    logger.debug(`Created usenet download for ${link}: ${res.data?.detail}`);
    if (
      res.data?.detail &&
      !res.data.detail.includes('Using cached download.')
    ) {
      logger.debug(
        `Usenet download detected to not be cached, returning undefined`
      );
      return undefined;
    }
    let state: UsenetDownload['status'] = 'queued';

    const nzb = await this.torboxApi?.usenet.getUsenetList('v1', {
      id: res.data?.data?.usenetdownloadId?.toString(),
    });
    if (!nzb?.data?.data || nzb?.data?.error || nzb.data.success === false) {
      throw new Error(
        `Failed to get usenet list: ${nzb?.data?.error || 'Unknown error'}${nzb?.data?.detail ? '- ' + nzb.data.detail : ''}`
      );
    } else if (Array.isArray(nzb.data.data)) {
      throw new Error(`Unexpected response format for usenet download`);
    }

    const usenetDownload = nzb.data.data;

    if (usenetDownload.downloadFinished && usenetDownload.downloadPresent) {
      state = 'downloaded';
    } else if (usenetDownload.progress && usenetDownload.progress > 0) {
      state = 'downloading';
    }
    const files: UsenetDownload['files'] = [];
    for (const file of usenetDownload.files ?? []) {
      files.push({
        id: file.id,
        mimeType: file.mimetype,
        name: file.shortName ?? file.name,
        size: file.size,
      });
    }
    logger.debug(`Found matching usenet download`, {
      usenetDownloadId: usenetDownload.id,
      status: usenetDownload.downloadState,
      state: state,
    });

    return {
      usenetDownloadId: usenetDownload.id ?? res.data.data.usenetdownloadId,
      authId: usenetDownload.authId ?? res.data.data.authId,
      hash: usenetDownload.hash ?? res.data.data.hash,
      name: usenetDownload.name ?? undefined,
      status: state,
      files,
    };
  }
}
