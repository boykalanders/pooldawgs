import type { MetadataRoute } from "next";

// PWA manifest — makes PoolDawgs installable and "app-like" in fullscreen
// mobile browsers (Golden Spec: PWA friendly).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PoolDawgs — wagered pool",
    short_name: "PoolDawgs",
    description: "Stake $DDawgs, rack 'em up. Premium 3D pool in the Deputy Dawgs ecosystem.",
    start_url: "/practice",
    scope: "/",
    display: "standalone",
    orientation: "landscape",
    background_color: "#0a0e0c",
    theme_color: "#0a0e0c",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
