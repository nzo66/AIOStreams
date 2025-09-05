export * from './base';
export * from './predefined';
export * from './custom';
export * from './utils';

import { BaseFormatter, FormatterConfig } from './base';
import {
  TorrentioFormatter,
  TorboxFormatter,
  GDriveFormatter,
  LightGDriveFormatter,
  MinimalisticGdriveFormatter,
} from './predefined';
import { CustomFormatter } from './custom';
import { UserData } from '../db';

export function createFormatter(userData: UserData): BaseFormatter {
  switch (userData.formatter.id) {
    case 'torrentio':
      return new TorrentioFormatter(userData);
    case 'torbox':
      return new TorboxFormatter(userData);
    case 'gdrive':
      return new GDriveFormatter(userData);
    case 'lightgdrive':
      return new LightGDriveFormatter(userData);
    case 'minimalisticgdrive':
      return new MinimalisticGdriveFormatter(userData);
    case 'custom':
      if (!userData.formatter.definition) {
        throw new Error('Definition is required for custom formatter');
      }
      return CustomFormatter.fromConfig(
        userData.formatter.definition,
        userData
      );
    default:
      throw new Error(`Unknown formatter type: ${userData.formatter.id}`);
  }
}
