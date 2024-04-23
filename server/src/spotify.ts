import axios, { AxiosError, AxiosResponse } from "axios"
import { getSecret } from "./utils.js"
import { Playlist, PlaylistOverview, Session, Track } from "./structs.js"
import { getSpotifyTokens, updateTokens } from "./database.js"

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_APP_ID || ""
const SPOTIFY_SECRET_FILE = process.env.SPOTIFY_SECRET || ""
const SPOTIFY_SECRET = await getSecret(SPOTIFY_SECRET_FILE)
const CLIENT_URL = process.env.CLIENT_URL || ""
const SPOTIFY_REDIRECT = `${CLIENT_URL}/spotify`

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"

export interface SpotifyTokens {
  access: string
  expires: Date
  refresh: string
}

const getTokensFromTokenResponse = (now: Date, response: AxiosResponse) => {
  let body = response.data
  let access = body.access_token
  let expires = new Date(now.getTime() + body.expires_in * 1000)
  let refresh = body.refresh_token
  let tokens: SpotifyTokens = { access, expires, refresh }
  return tokens
}

const getSpotifyHeaders = () => ({
  "content-type": "application/x-www-form-urlencoded",
  Authorization:
    "Basic " +
    Buffer.from(SPOTIFY_CLIENT_ID + ":" + SPOTIFY_SECRET).toString("base64"),
})

export const exchangeAccessCodeForTokens = async (code: string) => {
  const now = new Date()
  const headers = getSpotifyHeaders()
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    redirect_uri: SPOTIFY_REDIRECT,
    client_secret: SPOTIFY_SECRET,
    client_id: SPOTIFY_CLIENT_ID,
  })
  try {
    let response = await axios.post(SPOTIFY_TOKEN_URL, params, { headers })
    return getTokensFromTokenResponse(now, response)
  } catch (e) {
    console.log(e)
    return undefined
  }
}

export const refreshTokens = async (
  sessionSlug: string,
  tokens: SpotifyTokens
) => {
  const now = new Date()
  const headers = getSpotifyHeaders()
  const params = {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh,
  }
  try {
    let response = await axios.post(SPOTIFY_TOKEN_URL, null, {
      headers,
      params,
    })
    let tokens = getTokensFromTokenResponse(now, response)
    updateTokens(sessionSlug, tokens)
    return tokens
  } catch (e) {
    let err = e as AxiosError
    console.log(err.response?.status)
    return undefined
  }
}

const getApiURLFromEndpoint = (endpoint: string) =>
  `https://api.spotify.com/v1${endpoint}`

const getAuthHeader = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
})

const nameRegex =
  /(.+)(( - )(Radio Mix|Full Length Version|Radio Edit|Deluxe Edition)?((Remastered )?([0-9][0-9][0-9][0-9])?( Remastered( Version)?| Remaster| Mix)?)?()?)/

const sanitiseName = (name: string) => {
  let match = name.match(nameRegex)
  if (!match) {
    return name
  } else {
    return match[1]
  }
}

const responseToArtist = (raw: any) => {
  let id = raw.id
  let name = raw.name
  return { id, name }
}

const responseToAlbum = (raw: any) => {
  let name = sanitiseName(raw.name)
  let art = raw.images.length > 0 ? raw.images[0].url : ""
  let artists = raw.artists.map(responseToArtist)
  let id = raw.id
  return { id, name, artists, art }
}

const responseToTrack = (raw: any) => {
  let id = raw.id
  let name = sanitiseName(raw.name)
  let album = responseToAlbum(raw.album)
  let artists = raw.artists.map(responseToArtist)
  let duration = raw.duration_ms
  return { id, name, album, artists, duration }
}

const responseToPlaylist = (raw: any) => {
  let id = raw.id
  let name = raw.name
  let art = raw.images[0].url
  let url = raw.external_urls.spotify
  let tracks = raw.tracks.total
  return { id, url, name, art, tracks }
}

const executeGetRequest = async <T>(
  sessionSlug: string,
  endpoint: string,
  dataCallback: (data: any) => T
) => {
  const url = getApiURLFromEndpoint(endpoint)
  let currentTokens = await getSpotifyTokens(sessionSlug)
  if (!currentTokens) {
    return undefined
  } else {
    const headers = getAuthHeader(currentTokens.access)
    try {
      let response = await axios.get(url, { headers })
      let data = response.data
      return dataCallback(data)
    } catch (e) {
      console.log(e)
      return undefined
    }
  }
}

const executePaginatedRequest = async <T, U>(
  sessionSlug: string,
  endpoint: string,
  outerCallback: (data: any, dataArray: U[]) => T,
  pageCallback: (dataArray: U[], data: any) => string | undefined
) => {
  const url = getApiURLFromEndpoint(endpoint)
  let tokens = await getSpotifyTokens(sessionSlug)
  if (!tokens) {
    return undefined
  } else {
    const headers = getAuthHeader(tokens.access)
    try {
      var next: string | undefined = url
      let pages = []
      let pageData: U[] = []
      while (next) {
        let response = await axios.get(next, { headers })
        let data = response.data
        pages.push(data)
        next = pageCallback(pageData, data)
      }
      return outerCallback(pages, pageData)
    } catch (e) {
      let err = e as AxiosError
      console.log(`${err.status}: ${err.message}`)
      return undefined
    }
  }
}

export const getSpotifyUser = async (sessionSlug: string) => {
  return executeGetRequest(sessionSlug, "/me", (data) => {
    return {
      name: data["display_name"],
      image: data["images"][0]["url"],
      id: data["id"],
    }
  })
}

export const getCurrentTrack = async (sessionSlug: string) => {
  return executeGetRequest(
    sessionSlug,
    "/me/player/currently-playing",
    (data) => {
      let item = data.item
      if (item) {
        let track = responseToTrack(item)
        return track
      } else {
        return undefined
      }
    }
  )
}

export const getQueue = async (sessionSlug: string) => {
  return executeGetRequest(sessionSlug, "/me/player/queue", (data) => {
    let current = responseToTrack(data.currently_playing)
    let queue = data.queue.map(responseToTrack)
    return {
      current,
      queue,
    }
  })
}

export const getPlaylists = async (sessionSlug: string) => {
  let playlists = await executePaginatedRequest<
    PlaylistOverview[],
    PlaylistOverview
  >(
    sessionSlug,
    "/me/playlists",
    (pages, pageData) => pageData,
    (dataArray, data) => {
      let items = data.items
      for (let item of items) {
        dataArray.push(responseToPlaylist(item))
      }
      return items.next ? items.next : undefined
    }
  )
  return playlists
}

export const getPlaylistOverview = async (
  sessionSlug: string,
  playlistId: string
) => {
  let playlist = await executeGetRequest<PlaylistOverview>(
    sessionSlug,
    `/playlists/${playlistId}`,
    (data) => {
      let id = data.id
      let art = data.images[0].url
      let name = data.name
      let url = data.external_urls.spotify
      let tracks = data.tracks.total
      return { id, url, name, art, tracks }
    }
  )
  return playlist
}

export const getPlaylistDetails = async (
  sessionSlug: string,
  playlistId: string
) => {
  let playlist = await executePaginatedRequest<Playlist, Track>(
    sessionSlug,
    `/playlists/${playlistId}`,
    (pages, pageData) => {
      let first = pages[0]
      let id = first.id
      let art = first.images[0].url
      let name = first.name
      let url = first.external_urls.spotify
      let tracks = pageData
      return { id, url, name, art, tracks }
    },
    (array, data) => {
      let tracks = data.tracks.items
      for (let track of tracks) {
        array.push(responseToTrack(track.track))
      }
      return tracks.next ? tracks.next : undefined
    }
  )
  return playlist
}

export const getSessionOverview = async (
  sessionId: number,
  sessionName: string,
  sessionSlug: string,
  sessionHost: string,
  playlistId: string | undefined
) => {
  let playlist = !playlistId
    ? undefined
    : await getPlaylistOverview(sessionSlug, playlistId)
  let current = await getCurrentTrack(sessionSlug)
  return {
    id: sessionId,
    name: sessionName,
    slug: sessionSlug,
    host: sessionHost,
    playlist,
    current,
  }
}
