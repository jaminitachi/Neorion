const DOMAIN_PALETTE = [
  '#FF6B6B', '#4ECDC4', '#A78BFA', '#FFAE55',
  '#73C653', '#F38ECB', '#57A5F5', '#D7CD56',
  '#C9936F', '#A6DCAD', '#70D6FF', '#DD92F0',
];

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
  
    public static getColor(domain: string, sortedIndex: number): string {
      if (domain === 'other') return '#989898';
      if (sortedIndex < DOMAIN_PALETTE.length) return DOMAIN_PALETTE[sortedIndex];

      // Sample hues at golden-angle intervals. Convert HSL to hex for vis-network.
      const hue = (sortedIndex - DOMAIN_PALETTE.length) * 137.507764 % 360;
      const saturation = 0.7;
      const lightness = 0.68;
      const amplitude = saturation * Math.min(lightness, 1 - lightness);
      const channel = (offset: number) => {
        const k = (offset + hue / 30) % 12;
        const value = lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(value * 255).toString(16).padStart(2, '0');
      };
      return `#${channel(0)}${channel(8)}${channel(4)}`;
    }
}
