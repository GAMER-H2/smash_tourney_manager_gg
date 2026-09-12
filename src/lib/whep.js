export function normalizeWhepUrl(value, baseUrl = globalThis.location?.href) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error("Enter a WHEP URL to start the preview.");

  let url;
  try {
    url = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
  } catch {
    throw new Error("The WHEP URL is not valid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The WHEP URL must use HTTP or HTTPS.");
  }

  return url.href;
}

export function resolveWhepSessionUrl(location, endpointUrl) {
  if (!location) return null;

  try {
    return new URL(location, endpointUrl).href;
  } catch {
    return null;
  }
}

function splitLinkHeader(value) {
  const links = [];
  let start = 0;
  let quoted = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    if (!quoted && character === "<") angleDepth++;
    if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (!quoted && angleDepth === 0 && character === ",") {
      links.push(value.slice(start, index));
      start = index + 1;
    }
  }

  links.push(value.slice(start));
  return links;
}

export function parseIceServers(linkHeader) {
  if (!linkHeader) return [];

  return splitLinkHeader(linkHeader).flatMap((entry) => {
    const urlMatch = entry.match(/^\s*<([^>]+)>/);
    const relMatch = entry.match(/;\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    const relations = (relMatch?.[1] || relMatch?.[2] || "").split(/\s+/);
    if (!urlMatch || !relations.includes("ice-server")) return [];

    const usernameMatch = entry.match(/;\s*username\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
    const credentialMatch = entry.match(/;\s*credential\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
    const server = { urls: urlMatch[1] };
    const username = usernameMatch?.[1] ?? usernameMatch?.[2];
    const credential = credentialMatch?.[1] ?? credentialMatch?.[2];
    if (username !== undefined) server.username = username;
    if (credential !== undefined) server.credential = credential;
    return [server];
  });
}

export function waitForIceGatheringComplete(peerConnection, timeoutMs = 5000) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    let timeout;
    const finish = () => {
      clearTimeout(timeout);
      peerConnection.removeEventListener("icegatheringstatechange", handleChange);
      resolve();
    };
    const handleChange = () => {
      if (peerConnection.iceGatheringState === "complete") finish();
    };
    peerConnection.addEventListener("icegatheringstatechange", handleChange);
    timeout = setTimeout(finish, timeoutMs);
    handleChange();
  });
}

export class WhepClient {
  constructor({ endpoint, videoElement, onStateChange, fetchImpl = globalThis.fetch }) {
    this.endpoint = normalizeWhepUrl(endpoint);
    this.videoElement = videoElement;
    this.onStateChange = onStateChange || (() => {});
    this.fetchImpl = fetchImpl;
    this.abortController = new AbortController();
    this.peerConnection = null;
    this.sessionUrl = null;
    this.mediaStream = null;
    this.closed = false;
  }

  async connect() {
    this.onStateChange("connecting");

    let iceServers = [];
    try {
      const optionsResponse = await this.fetchImpl(this.endpoint, {
        method: "OPTIONS",
        signal: this.abortController.signal,
      });
      if (optionsResponse.ok) {
        iceServers = parseIceServers(optionsResponse.headers.get("Link"));
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // ICE server discovery is optional; host candidates are enough for a
      // typical MediaMTX instance on the local network.
    }

    if (this.closed) throw new DOMException("WHEP connection closed", "AbortError");

    const peerConnection = new RTCPeerConnection({ iceServers });
    this.peerConnection = peerConnection;
    peerConnection.addTransceiver("video", { direction: "recvonly" });
    peerConnection.addTransceiver("audio", { direction: "recvonly" });

    peerConnection.addEventListener("track", (event) => {
      if (this.closed) return;
      if (event.streams[0]) {
        this.mediaStream = event.streams[0];
      } else {
        this.mediaStream ||= new MediaStream();
        if (!this.mediaStream.getTracks().includes(event.track)) {
          this.mediaStream.addTrack(event.track);
        }
      }
      this.videoElement.srcObject = this.mediaStream;
      this.videoElement.play().catch(() => {});
    });

    peerConnection.addEventListener("connectionstatechange", () => {
      if (!this.closed) this.onStateChange(peerConnection.connectionState);
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection);
    if (this.closed) throw new DOMException("WHEP connection closed", "AbortError");

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/sdp",
        "Content-Type": "application/sdp",
      },
      body: peerConnection.localDescription.sdp,
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const details = (await response.text()).trim();
      throw new Error(
        `WHEP server returned ${response.status}${details ? `: ${details.slice(0, 200)}` : ""}`,
      );
    }

    this.sessionUrl = resolveWhepSessionUrl(
      response.headers.get("Location"),
      response.url || this.endpoint,
    );
    if (!this.sessionUrl) throw new Error("WHEP server did not return a session Location.");

    const answerSdp = await response.text();
    if (!answerSdp.trim()) throw new Error("WHEP server returned an empty SDP answer.");

    await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();

    const sessionUrl = this.sessionUrl;
    this.sessionUrl = null;
    if (sessionUrl) {
      this.fetchImpl(sessionUrl, { method: "DELETE" }).catch(() => {});
    }

    this.peerConnection?.close();
    this.peerConnection = null;

    if (this.videoElement?.srcObject === this.mediaStream) {
      this.videoElement.srcObject = null;
    }
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
  }
}
