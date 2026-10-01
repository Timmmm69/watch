import { MiniAppBootstrap } from "../../mini-app-bootstrap";

export default async function Page({ searchParams }: { searchParams: Promise<{ partnerId?: string }> }) {
  const { partnerId } = await searchParams;
  return <MiniAppBootstrap screen="adminPayouts" partnerId={typeof partnerId === "string" ? partnerId : undefined} />;
}
