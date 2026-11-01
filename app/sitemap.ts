import { MetadataRoute } from 'next';
import { supabaseServerCached } from '@/lib/supabaseServer';
import { SITE_URL } from '@/lib/linkPreview';

// Tenhle soubor appka automaticky promění na /sitemap.xml - je to seznam
// všech stránek appky, ať appka vyhledávačů ví, co všechno na appce
// zaindexovat (kromě toho, na co narazí sama procházením odkazů).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = SITE_URL;

  const staticRoutes = ['', '/explore', '/streams', '/about', '/login', '/signup', '/terms', '/privacy', '/rules', '/copyright', '/download', '/plus'].map((path) => ({
    url: `${baseUrl}${path}`,
    lastModified: new Date(),
  }));

  // Mapa webu se obnoví nejvýš jednou za hodinu (dřív jen při nasazení).
  const { data: videos } = await supabaseServerCached(3600)
    .from('videos')
    .select('id, created_at')
    .eq('status', 'ready')
    .eq('visibility', 'public')
    .order('created_at', { ascending: false })
    .limit(500);

  const videoRoutes = (videos ?? []).map((v) => ({
    url: `${baseUrl}/watch/${v.id}`,
    lastModified: new Date(v.created_at),
  }));

  const { data: channels } = await supabaseServerCached(3600)
    .from('profiles')
    .select('id, created_at')
    .limit(500);

  const channelRoutes = (channels ?? []).map((c) => ({
    url: `${baseUrl}/channel/${c.id}`,
    lastModified: new Date(c.created_at),
  }));

  return [...staticRoutes, ...videoRoutes, ...channelRoutes];
}
