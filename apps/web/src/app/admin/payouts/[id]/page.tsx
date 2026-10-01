import { MiniAppBootstrap } from "../../../mini-app-bootstrap";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MiniAppBootstrap screen="adminPayouts" payoutId={id} />;
}
