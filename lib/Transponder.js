const SharedPointer	= require("./SharedPointer");
const Emitter		= require("medooze-event-emitter");
const LayerInfo		= require("./LayerInfo");
const Native		= require("./Native");
const IncomingStreamTrack = require("./IncomingStreamTrack");
const SemanticSDP	= require("semantic-sdp");

/** @typedef {IncomingStreamTrack.ActiveLayersInfo['layers'][number]} LayerInfo */

/**
 * @typedef {Object} LayerSelection
 * Object describing which layers to forward (only applies to video tracks, ignored otherwise).
 *
 * @property {string} [encodingId] rid value of the simulcast encoding of the track (default: first encoding available, or for {@link Transponder.select}, the current encoding (no change))
 * @property {number} [spatialLayerId] The spatial layer id to send to the outgoing stream (default: max layer available)
 * @property {number} [temporalLayerId] The temporal layer id to send to the outgoing stream (default: max layer available)
 * @property {number} [maxSpatialLayerId] Max spatial layer id (default: unlimited)
 * @property {number} [maxTemporalLayerId] Max temporal layer id (default: unlimited)
 * @property {number} [maxWidth] Max width (default: unlimited)
 * @property {number} [maxHeight] Max height (default: unlimited)
 */

/**
 * @typedef {Object} SetTargetBitrateOptions Options for configuring algorithm to select best encoding/layers
 * @property {"default" | "spatial-temporal" | "zig-zag-spatial-temporal" | "temporal-spatial" | "zig-zag-temporal-spatial"} [traversal] Traversal algorithm [Default: "default"]
 * @property {boolean} [strict] If there is not a layer with a bitrate lower thatn target, stop sending media [Default: false]
 * @property {boolean} [smooth] When going to a lower simulcast layer, keep the higher one visible [Default: true]
 * @property {boolean} [useDefaultEncoding] If there are no active layers, use the default encoding [Default: false]
 * @property {string[]} [codecs] Codec preferences list in descending order, layers with codec not present in codec list will be ignored
 */

/**
 * @typedef {Object} TransponderEvents
 * @property {(muted: boolean) => void} muted
 * @property {(self: Transponder) => void} stopped
 */

// in JSDoc syntax, 'Number' (boxed type) is taken to mean 'number' (primitive type),
// so we have to do some shenanigans to refer to 'Number' specifically:
const __aNumber = new Number;
/** @typedef {typeof __aNumber & TargetBitrateInfo} TargetBitrateValue */

/**
 * @typedef {Object} TargetBitrateInfo properties of the number returned by {@link setTargetBitrate} and {@link setTargetBitrateAsync}
 * @property {LayerInfo[]} layers available layers
 * @property {LayerInfo} [layer] selected layer
 * @property {number} layerIndex index of selected layer (unlike the other properties, this one will be -1 if no layer selected)
 * @property {string} [encodingId]
 * @property {number} [spatialLayerId]
 * @property {number} [temporalLayerId]
 */

/**
 * Transponder copies data from an incoming track to an outgoing track and allows stream modifications
 * @extends {Emitter<TransponderEvents>}
 */
class Transponder extends Emitter
{
	/**
	 * @ignore
	 * @hideconstructor
	 * private constructor
	 */
	constructor(
		/** @type {Native.RTPStreamTransponderFacade} */ transponder,
		/** @type {SemanticSDP.TrackType} */ media)
	{
		//Init emitter
		super();

		//Store native trasnceiver
		this.transponder = transponder; 
		//The media type
		this.media = media;
		//No track
		this.track = /** @type {IncomingStreamTrack | null} */ (null);
		this.encodingId = /** @type {string | null} */ (null);
		this.encoding = /** @type {IncomingStreamTrack.Encoding | null} */ (null);
		this.muted = false;
		this.spatialLayerId = LayerInfo.MaxLayerId;
		this.temporalLayerId = LayerInfo.MaxLayerId;
		this.maxSpatialLayerId = LayerInfo.MaxLayerId;
		this.maxTemporalLayerId = LayerInfo.MaxLayerId;
		this.maxWidth = 0;
		this.maxHeight = 0;
		
		//The listener for attached tracks end event
		this.onAttachedTrackStopped = () => {
			//If stopped already
			if (!this.transponder)
				//Do nothing
				return;
			//Signal dettached
			this.track.detached();
			//Dettach
			this.track = null;
			//Stop listening
			this.transponder.ResetIncoming();
			//No encoding
			this.encodingId = null;
			this.encoding = null;
		};
		//Listener for when new encodings become avialable
		this.onAttachedTrackEncoding = (
			/** @type {IncomingStreamTrack} */ incomingStreamTrack,
			/** @type {IncomingStreamTrack.Encoding} */ encoding,
		) => {
			//If we don't have an encoding yet or we were attached to this encoding previously
			if (this.track === incomingStreamTrack && (this.encodingId === null || this.encodingId == encoding.id))
			{
				//Start listening to the encoding
				this.select({
					encodingId		: encoding.id,
					spatialLayerId		: this.spatialLayerId,
					temporalLayerId		: this.temporalLayerId,
					maxSpatialLayerId	: this.maxSpatialLayerId,
					maxTemporalLayerId	: this.maxTemporalLayerId
				});
			} 
		};
	}
	
	/**
	 * Set incoming track
	 * @param {IncomingStreamTrack | null} track	- Incoming track to attach to, or null to detach
	 * @param {LayerSelection} [layers]		- Layer selection info
	 * @param {Boolean} [smooth]			- Wait until next valid frame before switching to the new encoding
	 */
	setIncomingTrack(track, layers, smooth)
	{

		//If it is the same track
		if (track && this.track == track)
			//Just select the layer
			return this.select(layers, smooth == undefined ? true : smooth);

		//Check we are not already closed
		if (!this.transponder)
			//Error
			throw new Error("Transponder is already closed");

		//If was previously attached
		if (this.track)
		{
			//Remove listeners listener
			this.track.off("stopped", this.onAttachedTrackStopped);
			this.track.off("encoding",this.onAttachedTrackEncoding);
			//Signal dettached
			this.track.detached();
		}
		
		//Store new track info
		this.track = track;
		
		//If removing track
		if (this.track)
		{
			//Get default encoding
			const defaultencoding = this.track.getDefaultEncoding();

			//IF the track has any encodings
			if (defaultencoding) {
				//Set defaults
				const curated = Object.assign({
					encodingId		: defaultencoding.id,
				},layers);

				//Start listening to the default encoding
				this.select(curated,!!smooth);
			} else {
				//Set defaults
				const curated = Object.assign({
					spatialLayerId		: LayerInfo.MaxLayerId,
					temporalLayerId		: LayerInfo.MaxLayerId,
					maxSpatialLayerId	: LayerInfo.MaxLayerId,
					maxTemporalLayerId	: LayerInfo.MaxLayerId,
					maxWidth		: 0,
					maxHeight		: 0,
				}, layers);

				//Store default values
				this.encodingId = curated.encodingId ?? null;
				this.setMaximumLayers(curated.maxSpatialLayerId,curated.maxTemporalLayerId)
				this.spatialLayerId = curated.spatialLayerId;
				this.temporalLayerId = curated.temporalLayerId;
				this.setMaximumDimensions(curated.maxWidth, curated.maxHeight);
			}

			//Add listeners
			this.track.on("encoding",this.onAttachedTrackEncoding);
			this.track.once("stopped",this.onAttachedTrackStopped);

			//Singal track is attached
			this.track.attached();

			//If it has h264 properties
			if (this.track.hasH264ParameterSets && this.track.hasH264ParameterSets())
				//Set it
				this.transponder.AppendH264ParameterSets(this.track.getH264ParameterSets());
		} else {
			//Stop listening
			this.transponder.ResetIncoming();
			//No encoding
			this.encodingId = null;
			this.encoding = null;
		}
	}
	
       /**
	* Set out of band negotiated H264 parameter sets
	* @param {String} sprop - H264 parameters sets
	*/
	appendH264ParameterSets(sprop)
	{
		this.transponder.AppendH264ParameterSets(sprop);
	}

	/**
	* Get Transponder media type
	*/
	getMedia()
	{
		return this.media;
	}
	
	/**
	 * Get attached track
	 * @returns {IncomingStreamTrack | null} track
	 */
	getIncomingTrack()
	{
		return this.track;
	}
	
	/**
	 * Get available encodings and layers
	 */
	getAvailableLayers()
	{
		return this.track ? this.track.getActiveLayers() : null;
	}

	/**
	 * Get available encodings and layers
	 */
	async getAvailableLayersAsync()
	{
		return this.track ? this.track.getActiveLayersAsync() : null;
	}
	
	
	/**
	 * Check if the track is muted or not
	 * @returns {boolean} muted
	 */
	isMuted()
	{
		return this.muted;
	}
	
	/**
	 * Mute/Unmute track
	 * This operation will not change the muted state of the stream this track belongs too.
	 * @param {boolean} muting - if we want to mute or unmute
	 */
	mute(muting) 
	{
		//If we are different
		if (this.muted!==muting)
		{
			//Store it
			this.muted = muting;
			
			//Call native transponder
			this.transponder && this.transponder.Mute(muting);
			
			this.emit("muted",this.muted);
		}
	}

	/**
	 * Set intra frame forwarding mode
	 * @param {boolean} intraOnlyForwarding - true if you want to forward only intra frames, false otherwise
	 */
	setIntraOnlyForwarding(intraOnlyForwarding) 
	{
		//Set it in native object
		this.transponder.SetIntraOnlyForwarding(!!intraOnlyForwarding);
	}

	/**
	 * Select encoding and temporal and spatial layers based on the desired bitrate. This operation will unmute the transponder if it was muted and it is possible to select an encoding and layer based on the target bitrate and options.
	 * 
	 * @param {number} target Target bitrate
	 * @param {SetTargetBitrateOptions} [options]
	 * @returns {TargetBitrateValue | undefined} Current bitrate of the selected encoding and layers, it also includes the selected layer indexes and available layers as properties of the Number object.
	 */
	setTargetBitrate(target, options) 
	{
		//Check track
		if (!this.track)
			//Ignore
			return;
		//Current encoding
		const prevEncodingId    = this.encodingId;
		//For optimum fit
		let current		= -1;
		let encodingId		= "";
		let spatialLayerId	= LayerInfo.MaxLayerId;
		let temporalLayerId	= LayerInfo.MaxLayerId;
		//For minimum fit
		let min			= Number.MAX_SAFE_INTEGER;
		let encodingIdMin	= "";
		let spatialLayerIdMin	= LayerInfo.MaxLayerId;
		let temporalLayerIdMin	= LayerInfo.MaxLayerId;
		
		let ordering = /** @type {(a: LayerInfo, b: LayerInfo) => number} */ (/** @type {any} */ (false));
		
		//Helper for retrieving spatial info
		const getSpatialLayerId = function(/** @type {LayerInfo} */ layer) {
			// Either spatialLayerId on SVC stream or simulcastIdx on simulcast stream
			return layer.spatialLayerId!=LayerInfo.MaxLayerId ? layer.spatialLayerId : layer.simulcastIdx ;
		};

		//Depending on the traversal method
		switch (options?.traversal)
		{
			case "spatial-temporal":
				ordering = (a,b) => ((getSpatialLayerId(b)*LayerInfo.MaxLayerId+b.temporalLayerId) - (getSpatialLayerId(a)*LayerInfo.MaxLayerId+a.temporalLayerId));
				break;
			case "zig-zag-spatial-temporal":
				ordering = (a,b) => (((getSpatialLayerId(b)+b.temporalLayerId+1)*LayerInfo.MaxLayerId-b.temporalLayerId) - ((getSpatialLayerId(a)+a.temporalLayerId+1)*LayerInfo.MaxLayerId-a.temporalLayerId));
				break;
			case "temporal-spatial":
				ordering = (a,b) => ((b.temporalLayerId*LayerInfo.MaxLayerId+getSpatialLayerId(b)) - (a.temporalLayerId*LayerInfo.MaxLayerId+getSpatialLayerId(a)));
				break;
			case "zig-zag-temporal-spatial":
				ordering = (a,b) => (((getSpatialLayerId(b)+b.temporalLayerId+1)*LayerInfo.MaxLayerId-getSpatialLayerId(b)) - ((getSpatialLayerId(a)+a.temporalLayerId+1)*LayerInfo.MaxLayerId-getSpatialLayerId(a)));
				break;
			default:
				//If we are filtering bymin/max we use the "spatial-tempral" ordering
				//TODO: use (target)Width/(target)Height for ordering too?
				if (this.maxWidth || this.maxHeight)
					ordering = (a,b) => ((getSpatialLayerId(b)*LayerInfo.MaxLayerId+b.temporalLayerId) - (getSpatialLayerId(a)*LayerInfo.MaxLayerId+a.temporalLayerId));
		}

		//If we want to filter by codecs
		const codecs = options?.codecs?.map(codec => codec.toLowerCase());
		/** @type {((a: LayerInfo, b: LayerInfo) => number) | undefined} */
		const codecSortByPreference = codecs 
			? (a,b) => codecs.indexOf(a.codec) - codecs.indexOf(b.codec)
			: undefined;
		
		//Get all active layers 
		const info = this.track.getActiveLayers();
		
		//Filter layers by max TL and SL
		const filtered = info.layers.filter(layer=> this.maxSpatialLayerId>=layer.spatialLayerId
			&& this.maxTemporalLayerId>=layer.temporalLayerId
			&& (!codecs || codecs.includes(layer?.codec.toLowerCase()))
		);
		
		//Get layers and filter by max TL & SL
		//We expect spatial/simulcast layers to ensure that a layer with higher bitrate has also higher width/heights in order to be able to properly select based on maxWidth/maxHeight
		let layers = filtered;
		
		//If doing any sorting		
		if (ordering && codecSortByPreference)
			//Order codec preferences in descending order and traversal
			layers = layers.sort((a,b) => codecSortByPreference(a,b) || ordering(a,b));
		else if (ordering)
			//Order by traversal
			layers = layers.sort(ordering);
		else if (codecSortByPreference)
			//Order codec preferences in descending order and bitrate
			layers = layers.sort((a,b) => codecSortByPreference(a,b) || IncomingStreamTrack.sortByBitrateReverse(a,b));
		
		//If there are no layers
		if (!layers.length)
		{
			//Check if we want to select the default encoding if no active layers are found
			const fallback = this.track.getDefaultEncoding();
			if (options?.useDefaultEncoding && fallback)
				//Try to select it
				this.selectEncoding(fallback.id, options?.smooth);

			//Important: Do not mute us!
			//Not sending anything
			return Object.assign(new Number(0),{
				layerIndex	: -1, //Do not set the defaultEncodingId as the layers are empty
				layers		: layers
			});
		}
		
		//selected layer index
		let layerMinIndex = 0;
		let layerIndex = 0;
		//Try to do layer selection instead
		for (let layer of layers)
		{
			//Use the max of the actual and signaled target bitrate
			const layerBitrate = layer.targetBitrate ? Math.max(layer.bitrate, layer.targetBitrate) : layer.bitrate;
			//If this layer is better than the one before
			if (layerBitrate<=target && layerBitrate>current &&
			    this.maxSpatialLayerId>=layer.spatialLayerId && this.maxTemporalLayerId>=layer.temporalLayerId &&
			    (!this.maxWidth || ((layer.width || layer.targetWidth) <= this.maxWidth)) &&
			    (!this.maxHeight || ((layer.height || layer.targetHeight) <= this.maxHeight))
			)
			{
				//Use it as is
				encodingId	= layer.encodingId;
				spatialLayerId	= layer.spatialLayerId;
				temporalLayerId	= layer.temporalLayerId;
				//Update max current bitrate
				current = layerBitrate;
				//we don't want to look more
				break;
			}
			//Check if it is the minimum
			if (layerBitrate && layerBitrate<min &&
			    this.maxSpatialLayerId>=layer.spatialLayerId && this.maxTemporalLayerId>=layer.temporalLayerId)
			{
				//Use it as min
				layerMinIndex		= layerIndex;
				encodingIdMin		= layer.encodingId;
				spatialLayerIdMin	= layer.spatialLayerId;
				temporalLayerIdMin	= layer.temporalLayerId;
				//Update min bitrate
				min = layerBitrate;
			}
			//Next
			layerIndex++;
		}

		//Check if we have been able to find a layer that matched the target bitrate
		if (current<=0)
		{
			//If we can use the minimun
			if (!options || !options["strict"])
			{
				//Unmute (jic)
				this.mute(false);
				//Select mimimun as no layer is able to match the desired bitrate
				this.selectEncoding(encodingIdMin);
				//And temporal/spatial layers
				this.selectLayer(spatialLayerIdMin,temporalLayerIdMin);
				//Return minimun bitrate for selected encoding/layer
				return Object.assign(new Number(min),{
					layer		: layers[layerMinIndex],
					layerIndex	: layerMinIndex,
					encodingId	: encodingIdMin,
					spatialLayerId	: spatialLayerIdMin,
					temporalLayerId	: temporalLayerIdMin,
					layers		: layers
				});
			} else {
				//Mute it
				this.mute(true);
				//Not sending anything
				return Object.assign(new Number(0),{
					layerIndex	: -1,
					layers		: layers
				});
			}
		}
		//Unmute (jic)
		this.mute(false);
		//Find previous simulcastIdx and new one
		let prevSimulcastIdx = -1;
		let newSilmulcastIdx = -1;
		//For each active encoding
		for (const encoding of info.active)
			if (encoding.id == encodingId)
				//Get the simulcast Idx of the layer we are switching to
				newSilmulcastIdx = encoding.simulcastIdx;
			else if (encoding.id == prevEncodingId)
				//Get the simulcast Idx of the layer we are switching from
				prevSimulcastIdx = encoding.simulcastIdx;
		//We switch inmediatelly if going to a lower simulcast layer
		const smooth = !options || options.smooth || newSilmulcastIdx >= prevSimulcastIdx;
		//Select enccoding
		this.selectEncoding(encodingId,smooth);
		//And temporal/spatial layers
		this.selectLayer(spatialLayerId,temporalLayerId);
		//Return current bitrate for selected encoding/layer
		return Object.assign(new Number(current),{
			layer		: layers[layerIndex],
			layerIndex	: layerIndex,
			encodingId	: encodingId,
			spatialLayerId	: spatialLayerId,
			temporalLayerId	: temporalLayerId,
			layers		: layers
		});
	}

	/**
	 * Select encoding and temporal and spatial layers based on the desired bitrate. This operation will unmute the transponder if it was muted and it is possible to select an encoding and layer based on the target bitrate and options.
	 * 
	 * @param {number} target Target bitrate
	 * @param {SetTargetBitrateOptions} [options]
	 * @returns {Promise<TargetBitrateValue | undefined>} Current bitrate of the selected encoding and layers, it also includes the selected layer indexes and available layers as properties of the Number object.
	 */
	async setTargetBitrateAsync(target, options) 
	{
		//Check track
		if (!this.track)
			//Ignore
			return;
		//Current encoding
		const prevEncodingId    = this.encodingId;
		//For optimum fit
		let current		= -1;
		let encodingId		= "";
		let spatialLayerId	= LayerInfo.MaxLayerId;
		let temporalLayerId	= LayerInfo.MaxLayerId;
		//For minimum fit
		let min			= Number.MAX_SAFE_INTEGER;
		let encodingIdMin	= "";
		let spatialLayerIdMin	= LayerInfo.MaxLayerId;
		let temporalLayerIdMin	= LayerInfo.MaxLayerId;
		
		let ordering = /** @type {(a: LayerInfo, b: LayerInfo) => number} */ (/** @type {any} */ (false));
		
		//Helper for retrieving spatial info
		const getSpatialLayerId = function(/** @type {LayerInfo} */ layer) {
			// Either spatialLayerId on SVC stream or simulcastIdx on simulcast stream
			return layer.spatialLayerId!=LayerInfo.MaxLayerId ? layer.spatialLayerId : layer.simulcastIdx ;
		};
	
		//Depending on the traversal method
		switch (options?.traversal)
		{
			case "spatial-temporal":
				ordering = (a,b) => ((getSpatialLayerId(b)*LayerInfo.MaxLayerId+b.temporalLayerId) - (getSpatialLayerId(a)*LayerInfo.MaxLayerId+a.temporalLayerId));
				break;
			case "zig-zag-spatial-temporal":
				ordering = (a,b) => (((getSpatialLayerId(b)+b.temporalLayerId+1)*LayerInfo.MaxLayerId-b.temporalLayerId) - ((getSpatialLayerId(a)+a.temporalLayerId+1)*LayerInfo.MaxLayerId-a.temporalLayerId));
				break;
			case "temporal-spatial":
				ordering = (a,b) => ((b.temporalLayerId*LayerInfo.MaxLayerId+getSpatialLayerId(b)) - (a.temporalLayerId*LayerInfo.MaxLayerId+getSpatialLayerId(a)));
				break;
			case "zig-zag-temporal-spatial":
				ordering = (a,b) => (((getSpatialLayerId(b)+b.temporalLayerId+1)*LayerInfo.MaxLayerId-getSpatialLayerId(b)) - ((getSpatialLayerId(a)+a.temporalLayerId+1)*LayerInfo.MaxLayerId-getSpatialLayerId(a)));
				break;
			default:
				//If we are filtering bymin/max we use the "spatial-tempral" ordering
				//TODO: use (target)Width/(target)Height for ordering too?
				if (this.maxWidth || this.maxHeight)
					ordering = (a,b) => ((getSpatialLayerId(b)*LayerInfo.MaxLayerId+b.temporalLayerId) - (getSpatialLayerId(a)*LayerInfo.MaxLayerId+a.temporalLayerId));
		}

		//If we want to filter by codecs
		const codecs = options?.codecs?.map(codec => codec.toLowerCase());
		/** @type {((a: LayerInfo, b: LayerInfo) => number) | undefined} */
		const codecSortByPreference = codecs 
			? (a,b) => codecs.indexOf(a.codec) - codecs.indexOf(b.codec)
			: undefined;
		
		//Get all active layers 
		const info = await this.track.getActiveLayersAsync();
		
		//Filter layers by max TL and SL
		const filtered = info.layers.filter(layer=> this.maxSpatialLayerId>=layer.spatialLayerId
			&& this.maxTemporalLayerId>=layer.temporalLayerId
			&& (!codecs || codecs.includes(layer?.codec.toLowerCase()))
		);
		
		//Get layers and filter by max TL & SL
		//We expect spatial/simulcast layers to ensure that a layer with higher bitrate has also higher width/heights in order to be able to properly select based on maxWidth/maxHeight
		let layers = filtered;
		
		//If doing any sorting		
		if (ordering && codecSortByPreference)
			//Order codec preferences in descending order and traversal
			layers = layers.sort((a,b) => codecSortByPreference(a,b) || ordering(a,b));
		else if (ordering)
			//Order by traversal
			layers = layers.sort(ordering);
		else if (codecSortByPreference)
			//Order codec preferences in descending order and bitrate
			layers = layers.sort((a,b) => codecSortByPreference(a,b) || IncomingStreamTrack.sortByBitrateReverse(a,b));
		
		//If there are no layers
		if (!layers.length)
		{
			//Check if we want to select the default encoding if no active layers are found
			const fallback = this.track.getDefaultEncoding();
			if (options?.useDefaultEncoding && fallback)
				//Try to select it
				this.selectEncoding(fallback.id, options?.smooth);

			//Important: Do not mute us!
			//Not sending anything
			return Object.assign(new Number(0),{
				layerIndex	: -1, //Do not set the defaultEncodingId as the layers are empty
				layers		: layers
			});
		}
		
		//selected layer index
		let layerMinIndex = 0;
		let layerIndex = 0;
		//Try to do layer selection instead
		for (let layer of layers)
		{
			//Use the max of the actual and signaled target bitrate
			const layerBitrate = layer.targetBitrate ? Math.max(layer.bitrate, layer.targetBitrate) : layer.bitrate;
			//If this layer is better than the one before
			if (layerBitrate<=target && layerBitrate>current &&
			    this.maxSpatialLayerId>=layer.spatialLayerId && this.maxTemporalLayerId>=layer.temporalLayerId &&
			    (!this.maxWidth || ((layer.width || layer.targetWidth) <= this.maxWidth)) &&
			    (!this.maxHeight || ((layer.height || layer.targetHeight) <= this.maxHeight))
			)
			{
				//Use it as is
				encodingId	= layer.encodingId;
				spatialLayerId	= layer.spatialLayerId;
				temporalLayerId	= layer.temporalLayerId;
				//Update max current bitrate
				current = layerBitrate;
				//we don't want to look more
				break;
			}
			//Check if it is the minimum
			if (layerBitrate && layerBitrate<min &&
			    this.maxSpatialLayerId>=layer.spatialLayerId && this.maxTemporalLayerId>=layer.temporalLayerId)
			{
				//Use it as min
				layerMinIndex		= layerIndex;
				encodingIdMin		= layer.encodingId;
				spatialLayerIdMin	= layer.spatialLayerId;
				temporalLayerIdMin	= layer.temporalLayerId;
				//Update min bitrate
				min = layerBitrate;
			}
			//Next
			layerIndex++;
		}

		//Check if we have been able to find a layer that matched the target bitrate
		if (current<=0)
		{
			//If we can use the minimun
			if (!options || !options["strict"])
			{
				//Unmute (jic)
				this.mute(false);
				//Select mimimun as no layer is able to match the desired bitrate
				this.selectEncoding(encodingIdMin);
				//And temporal/spatial layers
				this.selectLayer(spatialLayerIdMin,temporalLayerIdMin);
				//Return minimun bitrate for selected encoding/layer
				return Object.assign(new Number(min),{
					layer		: layers[layerMinIndex],
					layerIndex	: layerMinIndex,
					encodingId	: encodingIdMin,
					spatialLayerId	: spatialLayerIdMin,
					temporalLayerId	: temporalLayerIdMin,
					layers		: layers
				});
			} else {
				//Mute it
				this.mute(true);
				//Not sending anything
				return Object.assign(new Number(0),{
					layerIndex	: -1,
					layers		: layers
				});
			}
		}
		//Unmute (jic)
		this.mute(false);
		//Find previous simulcastIdx and new one
		let prevSimulcastIdx = -1;
		let newSilmulcastIdx = -1;
		//For each active encoding
		for (const encoding of info.active)
			if (encoding.id == encodingId)
				//Get the simulcast Idx of the layer we are switching to
				newSilmulcastIdx = encoding.simulcastIdx;
			else if (encoding.id == prevEncodingId)
				//Get the simulcast Idx of the layer we are switching from
				prevSimulcastIdx = encoding.simulcastIdx;
		//We switch inmediatelly if going to a lower simulcast layer
		const smooth = !options || options.smooth || newSilmulcastIdx >= prevSimulcastIdx;
		//Select enccoding
		this.selectEncoding(encodingId,smooth);
		//And temporal/spatial layers
		this.selectLayer(spatialLayerId,temporalLayerId);
		//Return current bitrate for selected encoding/layer
		return Object.assign(new Number(current),{
			layer		: layers[layerIndex],
			layerIndex	: layerIndex,
			encodingId	: encodingId,
			spatialLayerId	: spatialLayerId,
			temporalLayerId	: temporalLayerId,
			layers		: layers
		});
	}

	/**
	 * Select the simulcast encoding layer and svc layers
	 * @param {LayerSelection} [layers]		- Layer selection info
	 * @param {Boolean} [smooth]			- Wait until next valid frame before switching to the new encoding
	 */
	select(layers,smooth)
	{
		//Set defaults
		const curated = Object.assign({
			encodingId		: this.getSelectedEncoding(),
			spatialLayerId		: LayerInfo.MaxLayerId,
			temporalLayerId		: LayerInfo.MaxLayerId,
			maxSpatialLayerId	: LayerInfo.MaxLayerId,
			maxTemporalLayerId	: LayerInfo.MaxLayerId,
			maxWidth		: 0,
			maxHeight		: 0,
		}, layers);
			
		//Start listening to the encoding
		this.selectEncoding(curated.encodingId,!!smooth);

		//Set maximum layers
		this.setMaximumLayers(curated.maxSpatialLayerId,curated.maxTemporalLayerId);

		//Set svc layers
		this.transponder.SelectLayer(curated.spatialLayerId,curated.temporalLayerId);

		//Set maximum width/height
		this.setMaximumDimensions(curated.maxWidth, curated.maxHeight);
	}

	/**
	 * Select the simulcast encoding layer
	 * @param {String} encodingId - rid value of the simulcast encoding of the track
	 * @param {Boolean} [smooth] - Wait until next valid frame before switching to the new encoding
	 */
	selectEncoding(encodingId,smooth) 
	{
		//If not found
		if (!this.track)
			//Error
			throw new Error("Transcoder is not attached");

		//Get encoding 
		const encoding = this.track.getEncoding(encodingId);
		//If not found
		if (!encoding)
			//Error
			throw new Error("Encoding id ["+encodingId+"] not found on transpoder track");
		//If not changed
		if (encoding===this.encoding)
			//Do nothing
			return;
		//Start listening to it
		this.transponder.SetIncoming(encoding.source.toRTPIncomingMediaStream(),encoding.receiver,!!smooth);
		//store encoding
		this.encodingId = encodingId;
		this.encoding = encoding;
	}
	
	/**
	 * Return the encoding that is being forwarded, or null if no track attached
	 * @returns {String | null} encodingId
	 */
	getSelectedEncoding()
	{
		// Return the encoding that is being forwarded
		return this.encodingId;
	}
	
	/**
	 * Return the spatial layer id that is being forwarded 
	 * @returns {Number} spatial layer id
	 */
	getSelectedSpatialLayerId()
	{
		// Return the spatial layer id that is being forwarded
		return this.spatialLayerId;
	}
	
	/**
	 * Return the temporal layer id that is being forwarded
	 * @returns {Number} temporal layer id
	 */
	getSelectedTemporalLayerId()
	{
		// Return the temporal layer id that is being forwarded
		return this.temporalLayerId;
	}

	/**
	 * Get current selected layer info
	 */
	getSelectedLayer()
	{
	
		//Check track
		if (!this.track)
			//Ignore
			return null;
		//Get all active layers 
		const layers = this.track.getActiveLayers().layers;

		//Find current layer
		return layers.find((layer)=>layer.encodingId==this.encodingId && layer.spatialLayerId==this.spatialLayerId && layer.temporalLayerId==this.temporalLayerId);
	}

	/**
	 * Get current selected layer info
	 */
	async getSelectedLayerAsync()
	{
	
		//Check track
		if (!this.track)
			//Ignore
			return null;
		//Get all active layers 
		const layers = (await this.track.getActiveLayersAsync()).layers;

		//Find current layer
		return layers.find((layer)=>layer.encodingId==this.encodingId && layer.spatialLayerId==this.spatialLayerId && layer.temporalLayerId==this.temporalLayerId);
	}
	
	/**
	 * Select SVC temporatl and spatial layers. Only available for VP9 media.
	 * @param {Number} spatialLayerId The spatial layer id to send to the outgoing stream
	 * @param {Number} temporalLayerId The temporal layer id to send to the outgoing stream
	 */
	selectLayer(spatialLayerId,temporalLayerId)
	{
		//Limit with max layers allowed
		if (this.maxSpatialLayerId)
			spatialLayerId  = Math.min(spatialLayerId,this.maxSpatialLayerId);
		if (this.maxTemporalLayerId)
			temporalLayerId = Math.min(temporalLayerId,this.maxTemporalLayerId);
		
		//Check if not changed
		if (this.spatialLayerId===spatialLayerId && this.temporalLayerId===temporalLayerId)
			//Nothing
			return;
		
		//Call native interface
		this.transponder.SelectLayer(spatialLayerId,temporalLayerId);
		
		//Store new values
		this.spatialLayerId = spatialLayerId;
		this.temporalLayerId = temporalLayerId;
	}

	/**
	 * Set maximum statial and temporal layers to be forwrarded. Base layer is always enabled.
	 * @param {Number} maxSpatialLayerId  - Max spatial layer id
	 * @param {Number} maxTemporalLayerId - Max temporal layer id
	 */
	setMaximumLayers(maxSpatialLayerId,maxTemporalLayerId)
	{
		//Check both are higher layers than the base layer
		if (maxSpatialLayerId<0 || maxTemporalLayerId<0)
			//Error
			throw new Error("Maximum layers not allowed, base layer (0,0) must be always enabled");
		//Store them
		this.maxSpatialLayerId  = maxSpatialLayerId;
		this.maxTemporalLayerId = maxTemporalLayerId;
	}
	
	/**
	 * Set maximum width and height to be forwarded
	 * @param {Number} maxWidth  - Max width (0: unlimited)
	 * @param {Number} maxHeight - Max height (0: unlimited)
	 */
	setMaximumDimensions(maxWidth, maxHeight)
	{
		//Store them
		this.maxWidth  = maxWidth;
		this.maxHeight = maxHeight;
	}

	/**
	 * Stop this transponder, will dettach the OutgoingStreamTrack
	 */
	stop()
	{
		//Don't call it twice
		if (!this.transponder) return;
		
		//Remove incoming track
		this.setIncomingTrack(null);
		
		//Stop it
		this.transponder.Close();
		
		this.emit("stopped",this);
		
		//Stop emitter
		super.stop();

		//Remove transport reference, so destructor is called on GC
		//@ts-expect-error
		this.transponder = null;
		//Remove track referecne also
		this.track = null;
	}
	
};


module.exports = Transponder;
