import {Transport} from "./Transport";
import Emitter from "medooze-event-emitter";
import LFSR from 'lfsr';
import { v4 as uuidV4 } from "uuid";
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
} from "semantic-sdp";
import {Endpoint, CreateTransportOptions} from "./Endpoint";
import { OutgoingStream } from "./OutgoingStream";

// Event types for PeerConnectionServer
interface PeerConnectionServerEvents {
    stopped: (self: PeerConnectionServer) => void;
	/** New managed transport has been created by a remote peer connection client */
    transport: (transport: Transport) => void;
}

/**
 * Manager of remote peer connecion clients
 */
export class PeerConnectionServer extends Emitter<PeerConnectionServerEvents>
{
	count: number;
    endpoint: Endpoint;
    capabilities: Capabilities;
    tm: any;
    transports: Set<Transport>;
    ns: any; // Namespace type from transport media manager

	constructor(
		endpoint: Endpoint, 
        tm: any, 
        capabilities: Capabilities, 
        options: CreateTransportOptions
	)
	{
		//Init emitter
		super();

		//Store stuff
		this.count = 0;
		this.endpoint = endpoint;
		this.capabilities = capabilities;
		this.tm = tm;
		
		//The created transports
		this.transports = new Set<Transport>();
		
		//Create our namespace
		this.ns = tm.namespace("medooze::pc");

		// bind `this` since this function will be called by event handler
		this.onEndpointStopped = this.onEndpointStopped.bind(this)
		
		//LIsten for creation events
		this.ns.on("cmd",(cmd: any)=>{
			//Get command nme
			switch(cmd.name) 
			{
				case "create" :
					//Process the sdp
					var offer = SDPInfo.expand(cmd.data);
					//Create an DTLS ICE transport in that enpoint
					const transport = this.endpoint.createTransport(offer, undefined, options);
					
					//Set RTP remote properties
					transport.setRemoteProperties(offer);

					//Create local SDP info
					const answer = offer.answer({
						dtls		: transport.getLocalDTLSInfo(),
						ice		: transport.getLocalICEInfo(),
						candidates	: this.endpoint.getLocalCandidates(),
						capabilities	: this.capabilities
					});
					
					//Set RTP local  properties
					transport.setLocalProperties(answer);
					
					//Get new transport id
					const id = this.count++;
					
					//Create namespace
					const pcns = this.tm.namespace("medooze::pc::"+id);
					
					//LIsten local events
					transport.on("outgoingtrack",(track,stream)=>{
						//Send new event
						pcns.event("addedtrack",{
							streamId: stream ? stream.getId() : "-",
							track	: track.getTrackInfo()
						});
						//Listen for close track
						track.once("stopped",()=>{
							//Send ended event
							pcns.event("removedtrack",{
								streamId:  stream ? stream.getId() : "-",
								trackId	: track.getId()
							});
						});
						//@ts-expect-error todo: figure out what this event is for and why its here
					}).on("outgoingstream",(stream: OutgoingStream)=>{
						//For each stream
						for (const track of stream.getTracks())
						{
							//Send new event
							pcns.event("addedtrack",{
								streamId:  stream ? stream.getId() : "-",
								track	: track.getTrackInfo()
							});
							//Listen for close track
							track.once("stopped",()=>{
								//Send ended event
								pcns.event("removedtrack",{
									streamId:  stream ? stream.getId() : "-",
									trackId	: track.getId()
								});
							});
						}
					}).on("stopped",()=>{
						//Remove from transports
						this.transports.delete(transport);
						//Send enven
						pcns.event("stopped");
						//Close ns
						pcns.close();

					});
					
					//Add to transport
					this.transports.add(transport);
					
					//Listen remote events
					pcns.on("event",(event: any)=>{
						//Get event data
						const data = event.data;
						//Depending on the event
						switch(event.name) 
						{
							case "addedtrack":
							{
								//Get events
								const streamId = data.streamId;
								const trackInfo = TrackInfo.expand(data.track);
								//Get stream 
								let stream = transport.getIncomingStream(streamId);
								//If we already have it
								if (!stream)
									//Create empty one
									stream = transport.createIncomingStream(new StreamInfo(streamId));
								//Create incoming track
								const track = stream.createTrack(trackInfo.media, trackInfo);
								break;
							}
							case "removedtrack":
							{
								//Get events
								const streamId = data.streamId;
								const trackId  = data.trackId;
								//Get stream 
								let stream = transport.getIncomingStream(streamId)
								//If we already have it
								if (!stream)
									return;
								//Get track
								const track = stream.getTrack(trackId);
								//If no track
								if (!track)
									return;
								//Stop track
								track.stop();
								//Id stream has no more tracks
								if (!stream.getTracks().length)
									//Stop it too
									stream.stop();
								break;
							}
							case "stop":
								//Stop transport
								transport.stop();
						}
					});
					
					//Done
					cmd.accept({
						id		: id,
						dtls		: answer.getDTLS().plain(),
						ice		: answer.getICE().plain(),
						candidates	: this.endpoint.getLocalCandidates(),
						capabilities	: this.capabilities
					});
					
					this.emit("transport",transport);
					
					break;
				default:
					cmd.reject("Command not recognised");
					break;
			}
		});
		
		//Stop when endpoint stop
		this.endpoint.once("stopped", this.onEndpointStopped);
	}

	private onEndpointStopped(): void {
		this.stop() 
	}
	
	/**
	 * Stop the peerconnection server, will not stop the transport created by it
	 */
	stop(): void
	{
		//Chheck not stopped alrady
		if (!this.endpoint)
			//Do nothing
			return;
		
		//Don't listen for stopped event
		this.endpoint.off("stopped",this.onEndpointStopped);
		
		//For all transports
		for (const transport of this.transports)
			//Stop them
			transport.stop();
		
		//Close ns
		this.ns.close();
		
		this.emit("stopped",this);
		
		//Stop emitter
		super.stop();
		
		//Null
		//@ts-expect-error
		this.transports = null;
		this.ns = null;
		//@ts-expect-error
		this.endpoint = null;
	}
}
