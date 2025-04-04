import Emitter from 'medooze-event-emitter';
import * as Native from './Native';
import * as SharedPointer from './SharedPointer';
import { v4 as uuidV4 } from 'uuid';
import {
    StreamInfo,
    TrackInfo,
    TrackType
} from 'semantic-sdp';
import {OutgoingStreamTrack, OutgoingTrackStats} from './OutgoingStreamTrack';
import {LayerSelection, Transponder} from './Transponder';
import {Transport} from './Transport';
import {IncomingStream} from './IncomingStream';

/**
 * @typedef {Object} OutgoingStreamEvents
 * @property {(self: OutgoingStream, stats: ReturnType<OutgoingStream['getStats']>) => void} stopped
 * @property {(track: OutgoingStreamTrack) => void} track Track was created
 * @property {(muted: boolean) => void} muted
 */

export interface OutgoingStreamEvents {
    stopped: (self: OutgoingStream, stats: ReturnType<OutgoingStream['getStats']>) => void;
	/** track was created */
    track: (track: OutgoingStreamTrack) => void;
    muted: (muted: boolean) => void;
}

/**
 * The incoming streams represent the media stream sent to a remote peer.
 */
export class OutgoingStream extends Emitter<OutgoingStreamEvents>
{
	id: string;
    muted: boolean = false;
    transport: Transport;
    info: StreamInfo;
    tracks: Map<string, OutgoingStreamTrack>;
    stopped?: boolean;

	constructor(id: string, transport: Transport) {
        super();
        this.id = id;
        this.transport = transport;
        this.info = new StreamInfo(id);
        this.tracks = new Map<string, OutgoingStreamTrack>();
    }
	
	/**
	 * Get statistics for all tracks in the stream
	 * 
	 * See {@link OutgoingStreamTrack.getStats} for information about the stats returned by each track.
	 * 
	 * @returns {{ [trackId: string]: OutgoingTrackStats }}
	 */
	getStats() : { [trackId: string]: OutgoingTrackStats }
	{
		const stats: { [trackId: string]: OutgoingTrackStats } = {};
		
		//for each track
		for (let track of this.tracks.values()) {
			//Append stats
			stats[track.getId()] = track.getStats();
		}

		return stats;
	}

	/**
	 * Get statistics for all tracks in the stream
	 * 
	 * See {@link OutgoingStreamTrack.getStats} for information about the stats returned by each track.
	 * 
	 * @returns {Promise<{ [trackId: string]: OutgoingStreamTrack.TrackStats }>}
	 */
	async getStatsAsync(): Promise<{ [trackId: string]: OutgoingTrackStats }> 
	{
		// construct a list of promises for each [track ID, track stats] entry
		const promises = this.getTracks().map(async track => (
			[track.getId(), await track.getStatsAsync()] ));

		// wait for all stats to arrive, and then assemble the object from the entries
		return Object.fromEntries(await Promise.all(promises));
	}
	
	/**
	 * Check if the stream is muted or not
	 * @returns {boolean} muted
	 */
	isMuted(): boolean
	{
		return this.muted;
	}
	
	/**
	 * Mute/Unmute this stream and all the tracks in it
	 * @param {boolean} muting - if we want to mute or unmute
	 */
	mute(muting: boolean): void
	{
		//For each track
		for (let track of this.tracks.values()) {
			//Mute track
			track.mute(muting);
		}

		//If we are different
		if (this.muted!==muting)
		{
			//Store it
			this.muted = muting;
			this.emit("muted",this.muted);
		}
	}
	
	/**
	 * Listen media from the incoming stream and send it to the remote peer of the associated transport.
	 * @param {import("./IncomingStream")} incomingStream	- The incoming stream to listen media for
	 * @param {Transponder.LayerSelection} [layers]		- Layer selection info
	 * @param {Boolean} [smooth]				- Wait until next valid frame before switching to the new encoding
	 * @returns {Transponder[]} Track transponders array
	 */
	attachTo(incomingStream: IncomingStream, layers?: LayerSelection, smooth?: boolean): Transponder[]
	{
		//Dettach
		this.detach();
		
		//The transponders
		const transponders: Transponder[] = [];
		
		//Get all of our audio streams
		const audio = this.getAudioTracks();
		
		//If we have any
		if (audio.length)
		{
			//Get incoming audiotracks
			const tracks = incomingStream.getAudioTracks();
			//Try to match each ones
			for (let i=0; i<audio.length && i<tracks.length; ++i)
				//Attach them
				transponders.push(audio[i].attachTo(tracks[i]));
		}
		
		//Get all of our audio streams
		const video = this.getVideoTracks();
		
		//If we have any
		if (video.length)
		{
			//Get incoming audiotracks
			const tracks = incomingStream.getVideoTracks();
			//Try to match each ones
			for (let i=0; i<video.length && i<tracks.length; ++i)
				//Attach them and get transponder
				transponders.push(video[i].attachTo(tracks[i], layers, smooth));
		}
		
		//Return transponders array
		return transponders;
	}
	
	/**
	 * Stop listening for media 
	 */
	detach(): void
	{
		//For each track
		for (let track of this.tracks.values()) {
			//Detach it
			track.detach();
		}
	}
	/**
	 * Get the stream info object for signaling the ssrcs and stream info on the SDP to the remote peer
	 * @returns {StreamInfo} The stream info object
	 */
	getStreamInfo(): StreamInfo
	{
		return this.info;
	}
	
	/**
	 * The media stream id as announced on the SDP
	 * @returns {String}
	 */
	getId(): string 
	{
		return this.id;
	}

	/**
	 * Get all the tracks
	 * @param {SemanticSDP.TrackType} [type]	- The media type (Optional)
	 * @returns {Array<OutgoingStreamTrack>}	- Array of tracks
	 */
	getTracks(type?: TrackType) 
	{
		//Create array from tracks
		const tracks = Array.from(this.tracks.values());
		//Return a track array
		return type ? tracks.filter(track => track.getMedia().toLowerCase()===type) : tracks;
	}
	
	/**
	 * Get track by id
	 * @param {String} trackId	- The track id
	 * @returns {OutgoingStreamTrack | undefined}	- requested track or null
	 */
	getTrack(trackId: string): OutgoingStreamTrack | undefined
	{
		//get it
		return this.tracks.get(trackId);
	}
	
	/**
	 * Get an array of the media stream audio tracks
	 * @returns {OutgoingStreamTrack[]}	- Array of tracks
	 */
	getAudioTracks(): OutgoingStreamTrack[] 
	{
		const audio: OutgoingStreamTrack[] = [];
		
		//For each track
		for (const track of this.tracks.values())
			//If it is an video track
			if(track.getMedia().toLowerCase()==="audio")
				//Append to tracks
				audio.push(track);
		//Return all tracks
		return audio;
	}
	
	/**
	 * Get an array of the media stream video tracks
	 * @returns {OutgoingStreamTrack[]}	- Array of tracks
	 */
	getVideoTracks(): OutgoingStreamTrack[] 
	{
		const video: OutgoingStreamTrack[] = [];
		
		//For each track
		for (const track of this.tracks.values())
			//If it is an video track
			if(track.getMedia().toLowerCase()==="video")
				//Append to tracks
				video.push(track);
		//Return all tracks
		return video;
	}
	
	/**
	 * Adds an incoming stream track created using {@link Transport.createOutgoingStreamTrack} to this stream
	 *  
	 * @param {OutgoingStreamTrack} track
	 */
	addTrack(track: OutgoingStreamTrack): void
	{
		//Ensure we don't have that id alread
		if (this.tracks.has(track.getId()))
			//Error
			throw new Error("Track id already present in stream");

		//Add track info to stream
		this.info.addTrack(track.getTrackInfo());

		//Add listener
		track.once("stopped",()=>{
			//Remove from info
			this.info.removeTrackById(track.getId());
			//Remove from map
			this.tracks.delete(track.getId());
		});
		//Add it to map
		this.tracks.set(track.getId(),track);
	}
	
	/**
	 * Create new track from a TrackInfo object and add it to this stream
	 * @param {SemanticSDP.TrackType} media Media type
	 * @param {SemanticSDP.TrackInfoLike} params Params plain object or TrackInfo object
	 * @returns {OutgoingStreamTrack}
	 */
	createTrack(media: TrackType, params: TrackInfo): OutgoingStreamTrack
	{
		//Delegate to transport
		return this.transport.createOutgoingStreamTrack(media, params, this);
	}
	
	stop(): void
	{
		//Don't call it twice
		if (this.stopped) return;

		//Stopped
		this.stopped = true;
		
		//Stop all streams it will detach them
		for (let track of this.tracks.values())
			//Stop track
			track.stop();

		//Get last stats for all tracks
		const stats = this.getStats();
		
		//Clear tracks jic
		this.tracks.clear();
		
		this.emit("stopped",this,stats);
		
		//Stop emitter
		super.stop();
		
		//Remove transport reference, so destructor is called on GC
		(this.transport as any) = null;
	}
};
