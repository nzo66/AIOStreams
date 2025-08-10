import { AnimeKitsuPreset } from '../presets/animeKitsu';
import { Cache } from '../utils';
import { Wrapper } from '../wrapper';
import { Metadata } from './utils';

export class KitsuMetadata {
  private readonly titleCache: Cache<string, Metadata>;
  private readonly titleCacheTTL = 7 * 24 * 60 * 60;
  //   private readonly kitsuAddon = new Wrapper({
  //     instanceId: 'kitsu',
  //     manifestUrl: 'https://kitsu.strem.io/manifest.json',
  //     enabled: true,
  //     preset: {
  //       type: 'anime-kitsu',
  //       id: 'kitsu',
  //       options: {},
  //     },
  //     name: 'Kitsu',
  //     timeout: 10000,
  //   });

  public constructor() {
    this.titleCache = Cache.getInstance('kitsu-title');
  }

  public async getMetadata(id: string, type: string): Promise<Metadata> {
    const [kitsuAddon] = await AnimeKitsuPreset.generateAddons(
      {
        sortCriteria: { global: [] },
        formatter: { id: 'gdrive' },
        presets: [],
      },
      {}
    );
    if (!id.startsWith('kitsu')) {
      throw new Error('Kitsu ID must start with "kitsu"');
    }
    const meta = await new Wrapper(kitsuAddon).getMeta(type, id);
    if (!meta.name || !meta.releaseInfo) {
      throw new Error('Kitsu metadata is missing title or year');
    }
    return {
      title: meta.name,
      titles: [meta.name, ...(meta.aliases ? (meta.aliases as string[]) : [])],
      year: Number(meta.releaseInfo?.toString().split('-')[0]),
    };
  }
}
