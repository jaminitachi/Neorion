import * as path from 'path';

export class DomainExtractor {
  private static readonly DOMAINS = [
    'auth',
    'admin',
    'novel',
    'create',
    'mypage',
    'store',
    'search',
    'library',
    'notice',
    'support',
    'terms',
    'genre'
  ];

  public static extract(filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    // Check for app directory domains
    if (normalizedPath.includes('/app/')) {
      for (const domain of this.DOMAINS) {
        if (normalizedPath.includes(`/app/${domain}`) || normalizedPath.includes(`/app/(${domain})`)) {
          return domain;
        }
        // Handle (auth) folder specifically if not caught above
        if (normalizedPath.includes(`/${domain}/`)) {
            return domain;
        }
      }
      return 'app-core'; // Fallback for app root
    }

    // Check for shared directories
    if (normalizedPath.includes('/components/')) return 'shared-ui';
    if (normalizedPath.includes('/hooks/')) return 'shared-hooks';
    if (normalizedPath.includes('/lib/')) return 'core-lib';
    if (normalizedPath.includes('/utils/')) return 'core-utils';
    if (normalizedPath.includes('/contexts/')) return 'core-state';

    return 'other';
  }

  public static getColor(domain: string): string {
    const colors: Record<string, string> = {
      'auth': '#FDCB6E',      // Yellow
      'admin': '#D63031',     // Red
      'novel': '#00B894',     // Green
      'create': '#0984E3',    // Blue
      'mypage': '#6C5CE7',    // Purple
      'store': '#E17055',     // Orange
      'search': '#74B9FF',    // Light Blue
      'shared-ui': '#B2BEC3', // Grey
      'app-core': '#636E72',  // Dark Grey
      'other': '#2D3436'      // Black/Dark
    };
    return colors[domain] || colors['other'];
  }
}
