import { MiniAppBootstrap } from "../../mini-app-bootstrap";

export default async function Page({ params }: { params: Promise<{ publicNumber: string }> }) {
  const { publicNumber } = await params;
  return <MiniAppBootstrap screen="orders" publicNumber={publicNumber} />;
}
