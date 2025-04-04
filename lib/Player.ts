import * as Native from "./Native";
import * as SharedPointer from "./SharedPointer";
import Emitter from "medooze-event-emitter";
import {IncomingStreamTrack} from "./IncomingStreamTrack";

interface PlayerEvents {
    stopped: (self: Player) => void;
	/** Playback ended */
    ended: (self: Player) => void;
}

interface PlayParams {
    repeat?: boolean;
}

export class Player extends Emitter<PlayerEvents>
{
	player: Native.PlayerFacade;
    tracks: Map<string, IncomingStreamTrack>;
    repeat?: boolean;

	// native callback
	private onended: () => void;

	constructor(filename: string)
	{
		//Init emitter
		super();
		
		//Check mp4 file name
		if (!filename || !filename.length)
			//Error
			throw new Error("MP4 filename nos specified");
		
		//Create native recorder
		this.player = new Native.PlayerFacade(this);
		
		//Open file
		if (!this.player.Open(filename))
			//Error
			throw new Error("MP4 filenamec could not be opened");
		
		//init track list
		this.tracks = new Map();
		
		//Check if player has video track
		if (this.player.HasVideoTrack())
		{
			//Fake track id
			const trackId = "video";
			
			//Get audio source
			const source = SharedPointer.SharedPointer(this.player.GetVideoSource());
			
			//Create new track
			const incomingStreamTrack = new IncomingStreamTrack("video",trackId,null!,null!,null!, {'':source}); // todo: figure out what to set here instead of a bunch of nulls
			
			//Add listener
			incomingStreamTrack.once("stopped",()=>{
				//REmove from map
				this.tracks.delete(trackId);
			});
			//Add it to map
			this.tracks.set(trackId,incomingStreamTrack);
		} 
		
		//If it has audio
		if (this.player.HasAudioTrack())
		{
			//Fake track id
			const trackId = "audio";
			
			//Get audio source
			const source = SharedPointer.SharedPointer(this.player.GetAudioSource());
			
			//Create new track
			const incomingStreamTrack = new IncomingStreamTrack("audio",trackId,null!,null!,null!, {'':source}); // todo: figure out what to set here instead of a bunch of nulls
			
			//Add listener
			incomingStreamTrack.once("stopped",()=>{
				//REmove from map
				this.tracks.delete(trackId);
			});
			//Add it to map
			this.tracks.set(trackId,incomingStreamTrack);
		}
		
		//Listener for player facade events
		this.onended = () => {
			//If already stopped
			if (!this.player)
				//Done
				return;
			//If we have to loop
			if (this.repeat)
			{
				//REstart rtp stugg
				this.player.Reset();
				//Start from the befiging
				this.seek(0);
				//DO nothing more
				return;
			}
			
			this.emit("ended",this);
		};
	}
	
	/**
	 * Get all the tracks
	* @returns {Array<IncomingStreamTrack>}	- Array of tracks
	 */
	getTracks(): IncomingStreamTrack[] 
	{
		//Return a track array
		return Array.from(this.tracks.values());
	}
	/**
	 * Get an array of the media stream audio tracks
	 * @returns {Array<IncomingStreamTrack>}	- Array of tracks
	 */
	getAudioTracks(): IncomingStreamTrack[] 
	{
		var audio = [];
		
		//For each track
		for (let track of this.tracks.values())
			//If it is an video track
			if(track.getMedia().toLowerCase()==="audio")
				//Append to tracks
				audio.push(track);
		//Return all tracks
		return audio;
	}
	
	/**
	 * Get an array of the media stream video tracks
	 * @returns {Array<IncomingStreamTrack>}	- Array of tracks
	 */
	getVideoTracks(): IncomingStreamTrack[] 
	{
		var video = [];
		
		//For each track
		for (let track of this.tracks.values())
			//If it is an video track
			if(track.getMedia().toLowerCase()==="video")
				//Append to tracks
				video.push(track);
		//Return all tracks
		return video;
	}

	/**
	 * Starts playback
	 * @param {Object} params	
	 * @param {Object} params.repeat - Repeat playback when file is ended
	 */
	play(params?: PlayParams)
	{
		//Get params
		this.repeat = params && params.repeat;
		//Start playback
		return this.player.Play();
	}
	
	/**
	 * Resume playback
	 */
	resume()
	{
		return this.player.Play();
	}
	
	/**
	 * Pause playback
	 */
	pause()
	{
		return this.player.Stop();
	}
	
	/**
	 * Start playback from given time
	 * @param {Number} time - in miliseconds
	 */
	seek(time: number)
	{
		return this.player.Seek(time);
	}
	
	/**
	 * Stop playing and close file
	 */
	stop()
	{
		//Don't call it twice
		if (!this.player) return;
		
		//Stop all streams it will detach them
		for (let track of this.tracks.values())
			//Stop track
			track.stop();
		
		//Clear tracks jic
		this.tracks.clear();
		
		//Close
		this.player.Close();
		
		this.emit("stopped",this);

		//Stop emitter
		super.stop();
		
		//Free
		//@ts-expect-error
		this.player = null;
	}
	
	
}
