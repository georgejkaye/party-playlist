import { Dispatch, SetStateAction } from "react"

export type SetState<T> = Dispatch<SetStateAction<T>>

export interface Artist {
    id: string
    name: string
}

export const getMultipleArtistsString = (artists: Artist[]) =>
    artists.map((artist) => artist.name).join(", ")

export interface Album {
    id: string
    name: string
    artists: Artist[]
    art: string
}

export interface Track {
    id: string
    name: string
    album: Album
    artists: Artist[]
    duration: number
}

export interface CurrentTrack {
    track: Track
    start: number
}