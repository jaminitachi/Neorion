export class DomainExtractor {
  
    public static extract(filePath: string): string {
      const normalizedPath = filePath.replace(/\\/g, '/');
      
      // Dynamic Domain Extraction for App Router
      // Matches: .../app/[domain]/... or .../src/app/[domain]/...
      // Captures the folder name immediately after 'app/'
      const appMatch = normalizedPath.match(/\/app\/([^\/]+)\//);
      if (appMatch) {
          const domain = appMatch[1];
          // Handle Next.js Route Groups like (auth) -> auth
          return domain.replace(/^\(|\)$/g, ''); 
      }
  
      // Check for shared directories
      if (normalizedPath.includes('/components/')) return 'shared-ui';
      if (normalizedPath.includes('/hooks/')) return 'shared-hooks';
      if (normalizedPath.includes('/lib/')) return 'core-lib';
      if (normalizedPath.includes('/utils/')) return 'core-utils';
      if (normalizedPath.includes('/contexts/')) return 'core-state';
      if (normalizedPath.includes('/store/')) return 'core-state';
      if (normalizedPath.includes('/types/')) return 'core-types';
  
      return 'other';
    }
  
    public static getColor(domain: string): string {
      // 1. Curated High-Contrast Palette (20 Distinct Colors)
      // Designed to be visually distinct against dark backgrounds
      const palette = [
        '#FF6B6B', // Red
        '#4ECDC4', // Teal
        '#45B7D1', // Cyan
        '#FFA07A', // Light Salmon
        '#989898', // Grey (Common)
        '#D980FA', // Lavender
        '#E17055', // Burnt Orange
        '#00CEC9', // Robin's Egg
        '#6C5CE7', // Purple
        '#FDCB6E', // Mustard
        '#0984E3', // Blue
        '#B2BEC3', // Silver
        '#FF7675', // Pink
        '#A29BFE', // Periwinkle
        '#00B894', // Green
        '#FD79A8', // Hot Pink
        '#636E72', // Slate
        '#FAB1A0', // Peach
        '#55E6C1', // Mint
        '#2D3436', // Charcoal (Rare)
      ];

      // Fixed mappings for core domains
      const fixedColors: Record<string, string> = {
        'other': palette[4],      
        'shared-ui': palette[11], 
        'shared-hooks': palette[13],
        'core-lib': palette[10],
        'core-utils': palette[2],
        'admin': palette[9],
        'auth': palette[8],
      };
      
      if (fixedColors[domain]) return fixedColors[domain];
  
      // 2. Hash to Palette Index
      // If domain isn't fixed, deterministically map it to one of the palette colors
      let hash = 0;
      for (let i = 0; i < domain.length; i++) {
        hash = domain.charCodeAt(i) + ((hash << 5) - hash);
      }
      const index = Math.abs(hash) % palette.length;
      return palette[index];
    }
  }
