import { z } from 'zod';
import { Stream } from '../../db';
import {
  Cache,
  Env,
  SERVICE_DETAILS,
  createLogger,
  getTimeTakenSincePoint,
} from '../../utils';
import { DebridService, DebridFile } from './debrid-service';
import { ParsedId } from '../utils/id-parser';
import { TorBoxSearchAddonUserDataSchema } from './schemas';
import TorboxSearchApi, {
  TorboxApiError,
  TorboxSearchApiIdType,
} from './search-api';
import { Torrent, convertDataToTorrents } from './torrent';
import { StremThruError } from 'stremthru';

const logger = createLogger('torbox-search');

abstract class SourceHandler {
  protected searchCache = Cache.getInstance<string, Torrent[]>(
    'torbox-search-torrents'
  );
  protected metadataCache = Cache.getInstance<string, string>(
    'torbox-search-metadata'
  );

  protected errorStreams: Stream[] = [];

  constructor(protected searchApi: TorboxSearchApi) {}

  abstract getStreams(
    parsedId: ParsedId,
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>
  ): Promise<Stream[]>;

  protected createStream(
    torrent: Torrent,
    file: DebridFile,
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>,
    season?: string,
    episode?: string
  ): Stream & { type: 'torrent' | 'usenet' } {
    const storeAuth = {
      storeName: file.service.id,
      storeCredential: userData.services.find(
        (service) => service.id === file.service.id
      )?.credential,
    };

    const playbackInfo =
      torrent.type === 'torrent'
        ? {
            type: 'torrent',
            hash: torrent.hash,
            index: file.index,
            season,
            episode,
          }
        : { type: 'usenet', nzb: torrent.nzb };

    const svcMeta = SERVICE_DETAILS[file.service.id];
    const name = `[${svcMeta.shortName} ${file.service.cached ? '⚡' : '⏳'}] TorBox Search`;
    const description = `${torrent.title}\n${file.filename}\n${torrent.indexer ? `🔍 ${torrent.indexer}` : ''} ${torrent.seeders ? `👤 ${torrent.seeders}` : ''} ${torrent.age && torrent.age !== '0d' ? `🕒 ${torrent.age}` : ''}`;

    return {
      url: `${Env.BASE_URL}/api/v1/debrid/resolve/${encodeURIComponent(Buffer.from(JSON.stringify(storeAuth)).toString('base64'))}/${encodeURIComponent(Buffer.from(JSON.stringify(playbackInfo)).toString('base64'))}/${encodeURIComponent(file.filename || torrent.title)}`,
      name,
      description,
      type: torrent.type,
      behaviorHints: {
        videoSize: file.size,
        filename: file.filename,
      },
    };
  }

  protected createErrorStream(error: {
    title: string;
    description: string;
  }): Stream {
    return {
      name: `[❌] TorBox Search ${error.title}`,
      description: error.description,
      externalUrl: 'stremio:///',
    };
  }
}

export class TorrentSourceHandler extends SourceHandler {
  private readonly debridServices: DebridService[];
  private readonly searchUserEngines: boolean;

  constructor(
    searchApi: TorboxSearchApi,
    services: z.infer<typeof TorBoxSearchAddonUserDataSchema>['services'],
    searchUserEngines: boolean,
    clientIp?: string
  ) {
    super(searchApi);
    this.debridServices = services.map(
      (service) => new DebridService(service, clientIp)
    );
    this.searchUserEngines = searchUserEngines;
  }

  async getStreams(
    parsedId: ParsedId,
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>
  ): Promise<Stream[]> {
    const { type, id, season, episode } = parsedId;
    let torrents: Torrent[] = [];
    try {
      torrents = await this.fetchTorrents(type, id, season, episode);
    } catch (error) {
      if (error instanceof TorboxApiError) {
        switch (error.errorCode) {
          case 'BAD_TOKEN':
            return [
              this.createErrorStream({
                title: ``,
                description: 'Invalid/expired credentials',
              }),
            ];
          default:
            throw error;
        }
      }
      throw error;
    }

    if (torrents.length === 0) return [];

    const requestedTitle = this.metadataCache.get(`metadata:${type}:${id}`);
    const filesByHash = await this.getAvailableFilesFromDebrid(
      torrents,
      parsedId,
      requestedTitle
    );

    const streams: Stream[] = [];
    for (const torrent of torrents) {
      const availableFiles = filesByHash.get(torrent.hash);
      if (availableFiles) {
        for (const file of availableFiles) {
          streams.push(
            this.createStream(torrent, file, userData, season, episode)
          );
        }
      }
    }

    streams.push(...this.errorStreams);

    return streams;
  }

  private async fetchTorrents(
    idType: TorboxSearchApiIdType,
    id: string,
    season?: string,
    episode?: string
  ): Promise<Torrent[]> {
    const cacheKey = `torrents:${idType}:${id}:${season}:${episode}`;
    const cachedTorrents = this.searchCache.get(cacheKey);

    if (cachedTorrents && !this.searchUserEngines) {
      logger.info(`Found ${cachedTorrents.length} (cached) torrents for ${id}`);
      return cachedTorrents;
    }

    const start = Date.now();
    const data = await this.searchApi.getTorrentsById(idType, id, {
      search_user_engines: this.searchUserEngines ? 'true' : 'false',
      season,
      episode,
    });

    const torrents = convertDataToTorrents(data.torrents);
    logger.info(
      `Found ${torrents.length} torrents for ${id} in ${getTimeTakenSincePoint(start)}`
    );

    if (data.metadata?.title) {
      this.metadataCache.set(
        `metadata:${idType}:${id}`,
        data.metadata.title,
        Env.BUILTIN_TORBOX_SEARCH_METADATA_CACHE_TTL
      );
    }

    this.searchCache.set(
      cacheKey,
      torrents.filter((torrent) => !torrent.userSearch),
      Env.BUILTIN_TORBOX_SEARCH_SEARCH_API_CACHE_TTL
    );

    return torrents;
  }

  private async getAvailableFilesFromDebrid(
    torrents: Torrent[],
    parsedId: ParsedId,
    requestedTitle?: string
  ): Promise<Map<string, DebridFile[]>> {
    const allFiles = new Map<string, DebridFile[]>();
    const servicePromises = this.debridServices.map((service) =>
      service.getAvailableFiles(torrents, parsedId, requestedTitle)
    );

    const results = await Promise.allSettled(servicePromises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value instanceof Array) {
          for (const file of result.value) {
            const existing = allFiles.get(file.hash) || [];
            allFiles.set(file.hash, [...existing, file]);
          }
        } else {
          this.errorStreams.push(
            this.createErrorStream({
              title: result.value.error.title,
              description: result.value.error.description,
            })
          );
        }
      }
    }
    return allFiles;
  }
}

export class UsenetSourceHandler extends SourceHandler {
  private readonly searchUserEngines: boolean;
  private readonly clientIp?: string;

  constructor(searchApi: TorboxSearchApi, searchUserEngines: boolean) {
    super(searchApi);
    this.searchUserEngines = searchUserEngines;
  }

  async getStreams(
    parsedId: ParsedId,
    userData: z.infer<typeof TorBoxSearchAddonUserDataSchema>
  ): Promise<Stream[]> {
    const { type, id, season, episode } = parsedId;
    const cacheKey = `usenet:${type}:${id}:${season}:${episode}`;
    let torrents = this.searchCache.get(cacheKey);

    if (!torrents) {
      const start = Date.now();
      try {
        const data = await this.searchApi.getUsenetById(type, id, {
          season,
          episode,
          check_cache: 'true',
          search_user_engines: this.searchUserEngines ? 'true' : 'false',
        });
        torrents = convertDataToTorrents(data.nzbs);
        this.searchCache.set(
          cacheKey,
          torrents,
          Env.BUILTIN_TORBOX_SEARCH_SEARCH_API_CACHE_TTL
        );
        logger.info(
          `Found ${torrents.length} NZBs for ${id} in ${getTimeTakenSincePoint(start)}`
        );
      } catch (error) {
        if (error instanceof TorboxApiError) {
          switch (error.errorCode) {
            case 'BAD_TOKEN':
              return [
                this.createErrorStream({
                  title: ``,
                  description: 'Invalid/expired credentials',
                }),
              ];
            default:
              logger.error(`Error fetching NZBs for ${id}: ${error.message}`);
              throw error;
          }
        }
        logger.error(`Unexpected error fetching NZBs for ${id}: ${error}`);
        throw error;
      }
    } else {
      logger.info(`Found ${torrents.length} (cached) NZBs for ${id}`);
    }

    return torrents.map((torrent) => {
      const file: DebridFile = {
        hash: torrent.hash,
        filename: torrent.title,
        size: torrent.size,
        index: -1,
        service: { id: 'torbox', cached: torrent.cached ?? false },
      };
      return this.createStream(torrent, file, userData, season, episode);
    });
  }
}
