import { redirect } from "next/navigation";

// The 3D table is now the practice page's default view (full game: cue stick,
// power, spin, ball-in-hand, all variants), so /play3d just points there.
export default function Play3DPage() {
  redirect("/practice");
}
