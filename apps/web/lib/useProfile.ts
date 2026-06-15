"use client";

import { useCallback, useEffect, useState } from "react";
import { useSignMessage } from "wagmi";
import { loginMessage, type Address, type PlayerProfile } from "@pooldawgs/shared";
import { getSocket } from "./socket";
import { log } from "./log";

/**
 * Live view of a wallet's server-side profile (display name, stats, won games).
 * `setUsername` authenticates the change with a wallet signature; the server
 * echoes the updated profile back over `profile:state`.
 */
export function useProfile(address?: string) {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signMessageAsync } = useSignMessage();

  useEffect(() => {
    if (!address) {
      setProfile(null);
      return;
    }
    const socket = getSocket();
    const lower = address.toLowerCase();
    const onState = (p: PlayerProfile) => {
      if (p.address.toLowerCase() === lower) setProfile(p);
    };
    const request = () => socket.emit("profile:get", { address: address as Address });
    socket.on("profile:state", onState);
    socket.on("connect", request);
    request();
    return () => {
      socket.off("profile:state", onState);
      socket.off("connect", request);
    };
  }, [address]);

  const setUsername = useCallback(
    async (username: string) => {
      if (!address) return;
      setError(null);
      setSaving(true);
      try {
        const ts = Date.now();
        const signature = await signMessageAsync({ message: loginMessage(address as Address, ts) });
        getSocket().emit("profile:set", {
          auth: { address: address as Address, ts, signature },
          username,
        });
      } catch (e) {
        log.error("profile: save failed —", e);
        setError(e instanceof Error ? e.message.split("\n")[0] : "Could not save name");
      } finally {
        setSaving(false);
      }
    },
    [address, signMessageAsync]
  );

  return { profile, setUsername, saving, error };
}
