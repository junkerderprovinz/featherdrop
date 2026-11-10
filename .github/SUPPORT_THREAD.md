<!--
Markdown copy of SUPPORT_THREAD.html, the text of the Unraid Community
Applications support thread. The HTML is what goes into the forum.
-->

# Title

[Support] junkerderprovinz - CastleParcel

# Body

**CastleParcel** is a self-hosted file sharer for big files: the transfer site you already know,
minus the accounts, the size paywall and someone else's cloud. Open the page, drop your files, choose how long they stay and how often they can be
downloaded, and share a short link or a QR code. Everything is encrypted in your browser before
it uploads, so not even your own server can read what you send. It runs as one small container and is set
up entirely from the Unraid template.

CastleParcel used to be called featherdrop. If you run featherdrop, open the container's
settings, change the Repository to `junkerderprovinz/castleparcel:latest` and leave the paths as
they are. Your shares and every link you sent keep working.

**Links**
- Source: https://github.com/junkerderprovinz/castleparcel
- Images: `junkerderprovinz/castleparcel:latest` on Docker Hub and `ghcr.io/junkerderprovinz/castleparcel:latest` (amd64 and arm64)
- Changelog: https://github.com/junkerderprovinz/castleparcel/releases

**Highlights**
- Zero-knowledge: files and their names are encrypted in the browser with libsodium (XChaCha20-Poly1305), and the key travels in the part of the link after the `#`, which browsers never send to the server
- An optional password on top of the link, to send over a second channel
- Expiry from one hour to 30 days or never, and an optional download limit
- Several files under one link, saved as one ZIP, plus encrypted text notes and file requests
- Resumable uploads, previews, 26 languages, light and dark, your own name, logo and accent colour
- A client you can check against the hashes of every release

**Requirements**
Unraid 6.10+. Put HTTPS in front of it before you share links outside your network and set
`BASE_URL` to the public address. Let large uploads through your reverse proxy.

**Bugs, problems, wishes**
The best place is an issue on GitHub: https://github.com/junkerderprovinz/castleparcel/issues.
For a bug, the Unraid version, the image tag, `docker logs --tail 200 CastleParcel` and the
browsers on both ends help a lot.

If CastleParcel saves you a trip to someone else's cloud, you can buy me a coffee:
https://buymeacoffee.com/junkerderprovinz
