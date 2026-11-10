import { MarketplaceHome } from "@/components/marketplace-home";
import { getPublicProviders } from "@/lib/providers";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export default async function Home() {
  const { providers, error } = await getPublicProviders();

  return (
    <main>
      <MarketplaceHome
        providers={providers}
        loadError={error}
        configured={isSupabaseConfigured()}
      />
    </main>
  );
}
