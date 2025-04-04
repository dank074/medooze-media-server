import {SDPManager} from './SDPManager';
import {
    SDPInfo,
    Setup,
    MediaInfo,
    CandidateInfo,
    DTLSInfo,
    ICEInfo,
    StreamInfo,
    TrackInfo,
    SourceGroupInfo,
	Capabilities,
} from 'semantic-sdp';
import {Endpoint} from './Endpoint';

export class SDPManagerPlanB extends SDPManager
{
	endpoint: Endpoint;
    capabilities: Capabilities;
    renegotiationNeeded: boolean;
    localInfo?: SDPInfo;
    remoteInfo?: SDPInfo;

	constructor(
		endpoint: Endpoint,
		capabilities: Capabilities)
	{
		//Init parent
		super();
		
		//Store params
		this.endpoint = endpoint;
		this.capabilities = capabilities;
		
		//Renegotiation needed flag
		this.renegotiationNeeded = false;
	}

	/** @override */
	createLocalDescription(): string
	{
		//If there is no local info
		if (!this.localInfo)
		{
			//Create initial offer
			this.localInfo = SDPInfo.create({
				dtls		: new DTLSInfo(Setup.ACTPASS,"sha-256",this.endpoint.getDTLSFingerprint()),
				ice		: ICEInfo.generate(true),
				candidates	: this.endpoint.getLocalCandidates(),
				capabilities	: this.capabilities
			});
		}
		
		//Clean all stream stuff
		this.localInfo.removeAllStreams();
		
		//If we already have transport
		if (this.transport)
			//Get all streams
			for (const stream of this.transport.getOutgoingStreams())
				//Add to local info
				this.localInfo.addStream(stream.getStreamInfo())
		
		//Modify status
		switch (this.state)
		{
			case "initial":
			case "stable":
				//This is an offer
				this.state = "local-offer";
				break;
			case "remote-offer":
				this.state = "stable";
				break;
		}
		//Return sdp
		return this.localInfo.toString();
	}
	
	/** @override */
	processRemoteDescription(sdp: string): void
	{
		//Renegotiate
		const renegotiate = () => {
			//Check if we already need to renegotiate
			if (!this.renegotiationNeeded && (this.state === 'initial' || this.state === 'stable'))
			{
				//Set flag
				this.renegotiationNeeded = true;
				//On next tick
				setTimeout(()=>{
					//Clean flag
					this.renegotiationNeeded = false;
					//Emit event
					this.emit("renegotiationneeded",this.transport!);
				},0);
			}
		};
		
		//Parse sdp
		this.remoteInfo = SDPInfo.parse(sdp);
		
		//If no transport
		if (!this.transport)
		{
			//Ceate new one
			this.transport = this.endpoint.createTransport(this.remoteInfo,this.localInfo);
			//If it was an offer
			if (!this.localInfo)
				//Answer it
				this.localInfo = this.remoteInfo.answer({
					dtls		: this.transport.getLocalDTLSInfo(),
					ice		: this.transport.getLocalICEInfo(),
					candidates	: this.endpoint.getLocalCandidates(),
					capabilities	: this.capabilities
				});
			//Set RTP local properties
			this.transport.setLocalProperties(this.localInfo);
			//Set RTP remote properties
			this.transport.setRemoteProperties(this.remoteInfo);
			
			//Set event listeners
			this.transport.on("outgoingtrack",(track,stream)=>{
				//Listen for events
				track.once("stopped", ()=>{
					//Renegotiate
					renegotiate();
				});
				//Renegotiate
				renegotiate();
			});
			
			//Emit event
			this.emit("transport",this.transport);
		}
		
		//If we need to anwser
		if (this.state!="local-offer")
			//Answer it
			this.localInfo = this.remoteInfo.answer({
				dtls		: this.transport.getLocalDTLSInfo(),
				ice		: this.transport.getLocalICEInfo(),
				candidates	: this.endpoint.getLocalCandidates(),
				capabilities	: this.capabilities
			});
		
		//For each ougoing stream
		for (const stream of this.transport.getIncomingStreams())
		{
			//Get info
			const streamInfo = this.remoteInfo.getStream(stream.getId());
			//If it was removed
			if (!streamInfo)
			{
				//Stop stream
				stream.stop();
				//Next
				continue;
			}
			//Check all tracks
			for (const track of stream.getTracks())
			{
				//Get info
				const trackInfo = streamInfo.getTrack(track.getId());
				//If it was removed
				if (!trackInfo)
					//Stop
					track.stop();
			}
		}
		
		//For each stream in remote sdp
		for (const [streamId,streamInfo] of this.remoteInfo.getStreams())
		{
			//Get stream
			const stream = this.transport.getIncomingStream(streamInfo.getId());
			
			//If not found
			if (!stream)
			{
				//Create new one
				this.transport.createIncomingStream(streamInfo);
				//Next
				continue;
			}
			
			//For all tracks
			for (const [trackId,trackInfo] of streamInfo.getTracks())
			{
				//Get track
				const track = stream.getTrack(trackInfo.getId());
				//If not found
				if (!track)
					//Create new one
					stream.createTrack(trackInfo.getMedia(), trackInfo);
			}
		}
		
		//Modify status
		switch (this.state)
		{
			case "initial":
			case "stable":
				//This is an offer
				this.state = "remote-offer";
				break;
			case "local-offer":
				this.state = "stable";
				break;
		}
	}
	
	
	/** @override */
	stop(): void
	{
		//Stop transport
		if (this.transport)
			this.transport.stop();

		//Stop SDPManager
		super.stop();
		
		//Free it
		this.transport = null;
		//@ts-expect-error
		this.endpoint = null;
	}
}

module.exports = SDPManagerPlanB;
