//Conor Kelton
//browselite-puppeteer.js 

//Description
//This is the puppeteer application used as the current implementation of the Browselite system

//The general flow is as follows:
// Opens the a debugging port for the page and uses lighthouse to load the page to collect various statistics.
// All images are set to Range Request 2KB to prevent Content Layout Shifts, to fire onload events for these images, and to keep general page integrity. 
// Images are matched to their corresponding DOM locations
// Image URLs are run through rule-based regexes in case they can be made smaller at the server
// Images are fetched using Range Requests at a percentage of their data as dictacted by the input parameter, 'nextPct'
// The 2KB images are replaced with the Range Requested contents, and reflected using the Web Canvas
// After the load of the page, lighthouse trials are recorded.

//Ex usage:
/*
node browselite-puppeteer ./data www.independent.co.uk 0.5 true true true
*/


const util = require('util');
const fs = require('fs');
const proc = require('process');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const lighthouse = require('lighthouse');
const log = require('lighthouse-logger');
const chromelauncher = require('chrome-launcher');
const fetch = require('node-fetch');
const events = require('events');
const puppeteer = require('puppeteer');
const Pixel2 = puppeteer.devices['Pixel 2'];

var dataDir = proc.argv[2]; 
var recordDomain = proc.argv[3]; 
var nextPct = parseFloat(proc.argv[4]);
var fillImages = (proc.argv[5] == 'true'); //Whether to make reflections
var doReplace = (proc.argv[6] == 'true'); //Whether to replace URLs
var doInterception = (proc.argv[7] == 'true'); //Whether to actually intercept and reduce images

//Lighthouse Options
var opts = {
	logLevel: 'info',
  	output: 'json',
  	disableNetworkThrottling: true,
  	disableCpuThrottling: true,
	settings:{
		onlyCategories: ['performance'],
		maxWaitForLoad: 5000,
		pauseAfterLoadMs: 5000,
	    networkQuietThresholdMs: 5000,
	    cpuQuietThresholdMs: 5000,
	},
	passes: [
		{
			passName: 'defaultPass',
			maxWaitForLoad: 5000,
			pauseAfterLoadMs: 5000,
		    networkQuietThresholdMs: 5000,
		    cpuQuietThresholdMs: 5000,
		},
	]
};

function sleep(milliseconds){
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			resolve();
		}, milliseconds);
	})
}

//For replacing image URLs
// This is a reduced set, full set usedavailable below with details in the WWW paper.
var regexPatts = {
	'width':[
		/width=[0-9]+/,
	],
	'height':[
		/height=[0-9]+/,
	],
	'quality':[
		/quality=[0-9]+/,
	],
	'format':[
		/format=[a-z]+/,
	]
};

var regexStrs = {
	'width':[
		'width=%w',
	],
	'height':[
		'height=%h',
	],
	'quality':[
		'quality=%q',
	],
	'format':[
		'format=%f',
	]
};

//Full set
var patterns = [
	'width=%w',
	'height=%w',
	'm=%w',
	'w=%w',
	'h=%h',
	'w_%w',
	'h_%h',
	'/%w/%h',
	'Cw=%w',
	'Ch=%h',
	'_x%w',
	'sWidth%w',
	'sWidth=%w',
	'sHeight%h',
	'sHeight=%h',
	'im_w=%w',
	'%w,%h',
	's=%w',
	's=%h',
	'nuevoancho=%w',
	'nuevoalto=%h',
	'resize/%w/',
	'resize/%h/',
	'resize/%wx%h/',
	'resize/%wx%w/',
	'downsize=%w',
	'downsize=%h',
	'/scale_crop/%w/',
	'/scale_crop/%h/',
	'SL%w',
	'SL%h',
	'q_%q',
	'quality=%q',
	'c%q',
	'format=%f',
	'auto=%f',
	'f_%f',
	'f=%f',
	'fmt_%f',
	'fmt=%f'
];

function main(){
	return new Promise( (resolve, reject) => {

		//Launch  with chrome launcher
		var chrome = null;
		var browser = null;
		var page = null;
		var report = null;

		var pageImages = {}; //growing list of replaced image objects
		var pageInnerWidth = null;
		var pageInnerHeight = null;
		var invalidPage = false; //Set if main HTML throws a 404
		var initialResponse = true;
		var globalImageID = 0; //Increments for each image
		var rangeFinished = false; //This can be updated to true to stop intercepting images at any point in the page load process.

		//This class contains the data and runtime for browselite
		class replacedImage {

			//Used to hold state for the images to actually fetch them in-browser
			// The logic can be done through puppeteer, but it is VERY slow to pass images back and forth over the debug protocol.
			constructor(url, method, headers){
				this.id = 0;
				this.url = url;
				this.replacedURL = null; //For pattern matching to reduce size at the server
				this.redirectURLs = [];
				this.method = method;
				this.headers = headers;
			}

			replaceAnyPatt(imgURL, imW, imH, imQ, imFmt){

				//This replaces any patterns fround in the URL corresponding to
				// known width, height, quality, and format patterns

				//While parameters corresponding to the known image dimensions from the browser can, and should, be used,
				// for now this is hard coded to our Pixel2 dimensions
				var replacedURL_ = imgURL;
				for(var type in regexPatts){

					var typePatts = regexPatts[type];
					var typeStrs = regexStrs[type];
					typePatts.forEach((regex, regexIdx) => {
						var regexStr = typeStrs[regexIdx];
						if(type == 'width'){
							regexStr = regexStr.replace('%w', imW);
							replacedURL_ = replacedURL_.replace(regex, regexStr);
						}
						else if(type == 'height'){
							regexStr = regexStr.replace('%h', imH);
							replacedURL_ = replacedURL_.replace(regex, regexStr);
						}
						else if(type == 'quality'){
							regexStr = regexStr.replace('%q', imQ);
							replacedURL_ = replacedURL_.replace(regex, regexStr);
						}
						else if(type == 'format'){
							regexStr = regexStr.replace('%f', imFmt);
							replacedURL_ = replacedURL_.replace(regex, regexStr);
						}
					});
				}
				this.replacedURL = replacedURL_; 
			}

			findImageParamsRemote(){
				var self = this;
				var domStart = Date.now();
				return new Promise((resolve, reject) => {
					//Go through the DOM and search for the image using puppeteer's query selection

					//NOTE: This procedure currently does not consider DOM contents of all types of images.
					// For now, img tags imgs with srcSet attributes and background images are supported.
					// e.g. <picture>/currentSrc will need to be considered in the future.
					// Lighthouse has a great methodology for determining currentSrc of images, can likely adopt this procedure.

					var potentialURLs = [self.url].concat(self.redirectURLs);

					//This search is done in parallel with the range request for the images
					//Either the image finishes, and it and its reflection are rendered, 
					//Or an event fires which renderes the image after we find its DOM node.
					function domSearch(potentialURLs){
						return new Promise((resolve, reject) => {

							var allHandles = [];
							var imgHandles = [];
							var handlePromises = [];
							var bgPromises = [];
							var jsHandlePromises = [];
							var imgSrcProperties = null;
							var imgMatched = false;

							//Should narrow this down to only potential image nodes.
							var handles = window.document.querySelectorAll('*');

							
							var currentSrcFields = [];
							handles.forEach((handle) => {
								imgHandles.push(handle);
								currentSrcFields.push(handle.currentSrc);
							});
							imgSrcProperties = currentSrcFields;

							var currentBgFields = [];
							imgHandles.forEach((handle) => {
								currentBgFields.push(getComputedStyle(handle, false).backgroundImage);
							});

							//Match any tags with the image
							console.log("Matching: ", potentialURLs[0]);
							window.pageImages[potentialURLs[0]]['elementHandles'] = [];
							window.pageImages[potentialURLs[0]]['elementHandleTypes'] = [];
							var imgMatched = false;
							imgSrcProperties.forEach((property, pNo) => {
								potentialURLs.forEach((pURL) => {
									if(pURL == property){
										imgMatched = true;
										window.pageImages[potentialURLs[0]].matched = true;
										window.pageImages[potentialURLs[0]].elementHandles.push(handles[pNo]);
										window.pageImages[potentialURLs[0]].elementHandleTypes.push('img');

										if(window.pageImages[potentialURLs[0]]['event']){
											window.pageImages[potentialURLs[0]]['event'].dispatchEvent(new CustomEvent('imgFinished', {detal:1}));
										}
										console.log("Found handle for: ", potentialURLs[0]);
									}
								});
							});

							//Match any tags with the BG image
							currentBgFields.forEach((property, pNo) => {
								if(property != 'none'){
									potentialURLs.forEach((pURL) => {
										try{			
											var propertyURL = property.match(/url\(["']?([^"']*)["']?\)/)[1];
											if(propertyURL){
												if(pURL == propertyURL){
													imgMatched = true;
													window.pageImages[potentialURLs[0]].matched = true;
													window.pageImages[potentialURLs[0]].elementHandles.push(handles[pNo]);
													window.pageImages[potentialURLs[0]].elementHandleTypes.push('bgImg');

													if(window.pageImages[potentialURLs[0]]['event']){
														window.pageImages[potentialURLs[0]]['event'].dispatchEvent(new CustomEvent('imgFinished', {detal:1}));
													}
													console.log("Found handle for: ", potentialURLs[0]);
												}
											}
										}catch(err){
											console.error(err);
										}
									});
								}
							});

							resolve(imgMatched);
						});
					};

					//Resolve before sending to range request image in parallel
					resolve();

					page.evaluate(domSearch, potentialURLs).then((imgMatched) => {

						console.log("Result for ", self.url, ":");
						console.log(imgMatched);
						if(imgMatched){
							var domEnd = Date.now();
						}
						else{
							var domEnd = Date.now();
							console.log("No handle found for url: ", self.url);  //Image has no handle, reject
						}
					});
				})
			}

			checkProgressiveImage(){

				//The following function uses imagemagick to check if an image is progressive
				// However, this causes quite a bit of overhead, both through spawning imagemagick and sending the image data over the debug protocol.

				// For now, since progressive images will be painted on the canvas in full, 
				// and the reflection is painted in the background, don't worry about it.

				// For additional efficiency we can use the bytes of the image (such as in buildDataURIRemote() ) to determine whether
				// or not it is interlaced similar to how imagemagick does.
				var self = this;
				function isProgressive(fileString){
					if(fileString.includes('non-interlaced')){
						return false;
					}
					else if(fileString.includes('interlaced')){
						return true;
					}
					else{
						if(fileString.includes('baseline')){
							return false;
						}
						else if(fileString.includes('progressive')){
							return true;
						}
						else{
							return false;
						}
					}
				}

				return new Promise((resolve, reject) => {

					fs.writeFileSync('./magick-canvas/temp-prog-check', self.imgIn);
					var isInterlaced = false;
					var checkInterlace = spawn('file', ['./magick-canvas/temp-prog-check']);

					checkInterlace.stdout.on('data', (interlaced) => {
						//console.log(interlaced.toString());
						isInterlaced = isProgressive(interlaced.toString());
					});

					checkInterlace.on('close', () => {
						if(isInterlaced){
							resolve(true);
						}
						else{
							resolve(false);
						}
					});
				});
			}

			buildDataURIRemote(){
				var self = this;
				return new Promise((resolve, reject) => {

					function browserBuildURI(url){
						return new Promise((resolve, reject) => {
							var reader = new FileReader();
							reader.onload = function(){
								window.pageImages[url]['dataURI'] = this.result;
								resolve();
							}
							reader.readAsDataURL(window.pageImages[url]['data']);
						});
					}

					page.evaluate(browserBuildURI, self.url).then(() => {
						console.log("Built URI in browser for:, ", self.url);
						resolve();
					});
				});
			}

			appendAllRemote(){
				var self = this;
				return new Promise((resolve, reject) => {
					var appendStart = Date.now();
					self.buildDataURIRemote(self.url).then(() => {

						function remoteDOMReplace(url, doFill){
							return new Promise((resolve, reject) => {
								var matched = window.pageImages[url].matched;

								if(matched){

									if(doFill){
										var imgs = window.pageImages[url].elementHandles;
										var handleTypes = window.pageImages[url].elementHandleTypes;

										
										var canv = document.createElement('canvas');
										var ctx = canv.getContext('2d');
										var tmpImg = new Image;
										tmpImg.onload = function(){

											//Create reflection on the canvas

											//NOTE: 
											// Some images do not display correctly without repainting.
											// This is likely a bug between the image's native format and the 'drawImage' function of the canvas.
											// The following procedure for reflectons may need to be tweaked to produce desired results.
											canv.width = tmpImg.width;
											canv.height = tmpImg.height;
											ctx.save();
											
											//Draw the partial image contents to the canvas
											// This is a hack to clear up formatting problems
											ctx.translate(0, canv.height);
											ctx.scale(1, -1);
											//ctx.drawImage(tmpImg, 0, 0, tmpImg.width, tpImg.height/2, 0, tmpImg.height/2, tmpImgWidth, tmpImg.height/2);
											ctx.filter = 'blur(8px)';
											ctx.drawImage(tmpImg, 0, 0);


											//Restore the original state of the canvas (drawing at top left) and begin the actual drawing
											ctx.restore();

											//Draw the original image again given that it has been transcribed onto the canvas
											ctx.drawImage(tmpImg, 0, 0);

											//Draw the reflected image, only up to the portion that has not yet been rendered
											ctx.globalCompositeOperation = 'destination-over';
											ctx.translate(0, canv.height);
											ctx.scale(1, -1);
											//ctx.drawImage(tmpImg, 0, 0, tmpImg.width, tpImg.height/2, 0, tmpImg.height/2, tmpImgWidth, tmpImg.height/2);
											ctx.filter = 'blur(8px)';
											ctx.drawImage(tmpImg, 0, 0);
											


											//Get the canvas data
											var canvDataURL = canv.toDataURL('image/jpeg');
											
											if(imgs.length > 0){
												imgs.forEach((img, imNo) => {
													if(handleTypes[imNo] == "bgImg"){
														img.style.backgroundImage = 'url("' + canvDataURL + '")';
													}
													else{
														img.setAttribute('src', canvDataURL);
														img.setAttribute('srcset', canvDataURL);
													}
												});
												resolve(true);									
											}
											else{
												resolve(false);
											}
											


										}
										tmpImg.src = window.pageImages[url]['dataURI'];
									}
									else{
										var imgs = window.pageImages[url].elementHandles;
										var handleTypes = window.pageImages[url].elementHandleTypes;
										var dataURL = window.pageImages[url]['dataURI'];
										if(imgs.length > 0){
											imgs.forEach((img, imNo) => {
												if(handleTypes[imNo] == "bgImg"){
													img.style.backgroundImage = 'url("' + dataURL + '")';
												}
												else{
													img.setAttribute('src', dataURL);
													img.setAttribute('srcset', dataURL);
												}
											});
											resolve(true);									
										}
										else{
											resolve(false);
										}
									}
								}
								else{
									//Listen for the match event
									window.pageImages[url]['event'] = new EventTarget('imgMatched');
									window.pageImages[url]['event'].addEventListener('imgMatched', () => {

										if(doFill){
											var transformStart = Date.now();
											var imgs = window.pageImages[url].elementHandles;
											var handleTypes = window.pageImages[url].elementHandleTypes;

											
											var canv = document.createElement('canvas');
											var ctx = canv.getContext('2d');
											var tmpImg = new Image;
											tmpImg.onload = function(){

												canv.width = tmpImg.width;
												canv.height = tmpImg.height;
												ctx.save();
												
												ctx.translate(0, canv.height);
												ctx.scale(1, -1);
												//ctx.drawImage(tmpImg, 0, 0, tmpImg.width, tpImg.height/2, 0, tmpImg.height/2, tmpImgWidth, tmpImg.height/2);
												ctx.filter = 'blur(8px)';
												ctx.drawImage(tmpImg, 0, 0);

												ctx.restore();
												ctx.drawImage(tmpImg, 0, 0);

												ctx.globalCompositeOperation = 'destination-over';
												ctx.translate(0, canv.height);
												ctx.scale(1, -1);
												//ctx.drawImage(tmpImg, 0, 0, tmpImg.width, tpImg.height/2, 0, tmpImg.height/2, tmpImgWidth, tmpImg.height/2);
												ctx.filter = 'blur(8px)';
												ctx.drawImage(tmpImg, 0, 0);


												//Get the canvas data
												var canvDataURL = canv.toDataURL('image/jpeg');
												
												if(imgs.length > 0){
													imgs.forEach((img, imNo) => {
														if(handleTypes[imNo] == "bgImg"){
															img.style.backgroundImage = 'url("' + canvDataURL + '")';
														}
														else{
															img.setAttribute('src', canvDataURL);
															img.setAttribute('srcset', canvDataURL);
														}
													});
												
													resolve(true);									
												}
												else{
													
													resolve(false);
												}
											}
											tmpImg.src = window.pageImages[url]['dataURI'];
										}
										else{

											var imgs = window.pageImages[url].elementHandles;
											var handleTypes = window.pageImages[url].elementHandleTypes;
											var dataURL = window.pageImages[url]['dataURI'];
											if(imgs.length > 0){
												imgs.forEach((img, imNo) => {
													if(handleTypes[imNo] == "bgImg"){
														img.style.backgroundImage = 'url("' + dataURL + '")';
													}
													else{
														img.setAttribute('src', dataURL);
														img.setAttribute('srcset', dataURL);
													}
												});
												resolve(true);									
											}
											else{
												resolve(false);
											}
										}

									});
								}
							});
						};

						var transformStart = Date.now();
						page.evaluate(remoteDOMReplace, self.url, fillImages).then(() => {
							var transformEnd = Date.now();
						});

						//Resolve immediately
						resolve();											
					});
				});
			}

			nextRangeRequestRemote(nextBytes){
				var self = this;
				var rangeStart = Date.now();
				return new Promise((resolve, reject) => {
					var responseHeaders = null;

					//Notes:
					// For responses that don't return a 206, we just continue, but should probably stop them after a certain point
					// For responses that do not support range requests we currently just abort
					// However, a refetch for the original image can easily be done here.

					// Similarly, for replaced URLs, if a 404 occurs due to replacement we currently just abort.
					// However, a backup request for the original image can also be done.

					// Additionally if the size of the image (due to rewriting or range requests) is larger than the size from the 2KB request
					// we should probably revert back to the original image.
					// For now, we just continue.
					function browserFetch(url, nextBytes, rURL){
						return new Promise((resolve, reject) => {

							//Here we are refetching the 2KB from the initial Range Request,
							//  however we could also append this initial 2KB to this new request and start from byte 2048 to optimize savings further. 
							var responseHeaders = null;
							window.pageImages[url]['headers']['Range'] = 'bytes=0-' + nextBytes;
							console.log('bytes=0-' + nextBytes);

							//Actually fetch the pattern replaced URL, but index the URL with its original URL
							fetch(rURL, {method:window.pageImages[url].method, headers:window.pageImages[url].headers}).then((response) => {
								if(response.status == 200){
									responseHeaders = response.headers;
									return response.blob();
								}
								else if(response.status == 206){
									responseHeaders = response.headers;
									return response.blob();
								}
								else{
									return Promise.reject();
								}
							}).then((imgBuff) => {
								//Store as a JS Blob
								window.pageImages[url]['data'] = imgBuff;
								resolve();
							});
						})
					}

					//NOTE:
					// Here, we should grab the image's displayed width and height parameters from the browser
					// For now just append with our test device's dimensions (411px width)
					// Our reported savings were done using the the image's naturalWidth/Height and browser determined css Widths and Heights.
					var IMG_WIDTH = 411;
					var IMG_HEIGHT = 411;
					var IMG_QUALITY = 85;
					var IMG_FORMAT = 'webp';
					if(doReplace){
						self.replaceAnyPatt(self.url, IMG_WIDTH, IMG_HEIGHT, IMG_QUALITY, IMG_FORMAT);
					}
					else{
						self.replacedURL = self.url;
					}

					page.evaluate(browserFetch, self.url, nextBytes, self.replacedURL).then(() => {
						var rangeEnd = Date.now();
						return self.appendAllRemote();
					}).then(() => {
						resolve();
					}).catch((err) => {
						console.error("Could not append!");
						reject(err);
					});
				});
			}
		}

		//This can be used to determine the page dimensions
		// This can be a factor in setting image dimensions for URL replacement.
		function setPageHeights(){
			return new Promise((resolve, reject) => {
				var scrollHeight = null;
				console.log("starting to set height!");
				page.evaluate(() => window.document.body.scrollHeight).then((pageSH) => {
					console.log(pageSH);
					scrollHeight = pageSH;
					return page.evaluate(() => window.innerHeight);
				}).then((pageIH) => {
					console.log(pageIH);
					pageInnerHeight = pageIH;
					return page.evaluate(() => window.innerWidth);
				}).then((pageIW) => {
					console.log(pageIW);
					pageInnerWidth = pageIW;
					resolve();
				});
			})
		}

		function remoteAllocateBandwidth(url, imgBandwidth){
			//This sends a request for x% of the image directly in the browser (50% as described in the paper and given in the example)

			//NOTE:
			//Currently this request is made for x% of the original image's size, determined via the initial 2KB range request, before rewriting.
			//While 50% of the replaced image can be requested, this will either:
			// a) Require an additional RTT to determine.
			// OR
			// b) Have rewriting be done at the initial time of the request which can slow down the layout of the page.

			// However, b) is difficult as it depends on the brorwser to determine the width and height of the image
			//  from its first 2KB, requiring additional levels of control and communication.

			pageImages[url].nextRangeRequestRemote(imgBandwidth).then(() => {
				console.log("Fetched: ", url);
			}).catch((err) => {
				console.error("Failed Range Request for url: ", url);
			});
		}


		function setPageEvents(navUrl){
			//This function sets up the puppeteer callbacks
			return new Promise( (resolve, reject) => {

				//Lighthouse will attach to already open tab, so create listeners on this tab.
				browser.pages().then((pages) => {
					page = pages[0];

					//Set page events
					if(doInterception){
						page.setRequestInterception(true).then(() => {
							
							page.on('request', (request) => {

								if(!rangeFinished){
									var rURL = new URL(request.url());
									if(request.resourceType() == "image" && (rURL.protocol == "http:" || rURL.protocol == "https:")){

										if(request.url() in pageImages){
											//NOTE:
											//A repeat request, can block it, but for now let it go through.
											//request.abort('blockedbyclient');
											request.continue();
										}
										else{

											//NOTE:
											//A slight timeout was needed here or the request.url() would sometimes return null. 
											setTimeout(() => {

												pageImages[request.url()] = new replacedImage(request.url(), request.method(), request.headers());
												pageImages[request.url()].id = globalImageID;
												pageImages[request.url()].firstRequest = true;


												globalImageID++;

												const headers = Object.assign({}, request.headers(), {
													Range: 'bytes=0-2047'
												});

												//Add to the window of the page to keep state
												page.evaluate((url, method, headers) => {
													if(!window.pageImages){
														window.pageImages = {};
													}
													window.pageImages[url] = {};
													window.pageImages[url]['method'] = method;
													window.pageImages[url]['headers'] = headers;
												}, request.url(), request.method(), request.headers()).then(() => {
													request.continue({headers});
												});
												
											}, 10);
										}
									}
									else{
										request.continue();
									}
								}
								else{
									request.continue();
								}
							});

							page.on('response', (response) => {

								//If this is the main HTML, check that we didn't hit a 404
								if(!rangeFinished){

									if(response.request().url() == navUrl){
										console.log(response.status());
										if(parseInt(response.status()) >= 400){
											invalidPage = true;
										}
										else{
											console.log("Main HTML OK!");
										}
									}

									var bodyData = null;
									var matchedRequest = null;
									response.buffer().then((_bodyData) => {
										
										//Lighthouse will contain info (but not respone data) of unmodified images
										// If response bodies need to be logged they can be gathered here and stored separately.
										if(response.request().url() in pageImages){

											if(pageImages[response.request().url()].firstRequest){

												//Only send the additional request once, other responses for this will come from the Fetch API in browser
												pageImages[response.request().url()].firstRequest = false;

												bodyData = _bodyData;
												matchedRequest = response.request();

												//Start finding the image in parallel
												pageImages[matchedRequest.url()].findImageParamsRemote();

												//Start fetching the rest of the image in parallel
												var rangeParsed = 2047;

												//The total bytes of the image can be found via the content-range response header of Range Requests
												for(var responseHeader in response.headers()){
													if(responseHeader.toLowerCase() == "content-range"){
														rangeParsed = parseInt(parseInt(response.headers()[responseHeader].split("/")[1].trim()) * nextPct);
														console.log("Found bytes for image: ", response.request().url(), " ", rangeParsed);
													}
												}

												remoteAllocateBandwidth(matchedRequest.url(), rangeParsed);
											}
											else{
												//We already dealt with this image, pass
											}
										}
										else{
											//This will be called when appending the dataURI for each image back to the page.
											//For now, pass
										}
									});
								}
							}, (err) => {
								//pass
								console.log(err);
							});

							//Resume control
							resolve();
						});
					}
					else{

						page.setRequestInterception(true).then(() => {
							page.on('request', (request) => {
								request.continue();
							});

							page.on('response', (response) => {
								//Filler
							});
						});

						resolve();
					}
				});		
			});
		}

		function setNetworkConditions(){
			return new Promise((resolve, reject) => {
				page.target().createCDPSession().then((cli) => {
					client = cli;
					return client.send('Network.enable');
				}).then(() => {
					return client.send('Network.emulateNetworkConditions', {
						//4G / Slow 3G 
						'offline': false,
						// Download speed (bytes/s)
						'downloadThroughput': //500000, 
						500 * 1024 / 8 * .8,
						// Upload speed (bytes/s)
						'uploadThroughput':// 250000,
						500 * 1024 / 8 * .8,
						// Latency (ms)
						'latency': 1000,
					})
				}).then(() => {
					resolve();
				});
			})
		}

		//Chrome launcher can be set to use any chromium installation
		//{chromePath:'/usr/bin/brave-browser'}
		chromelauncher.launch({
			chromeFlags:['--disable-web-security', '--disable-site-isolation-trials'],
		}).then((cr) => {
			console.log("Launched chrome!");
			chrome = cr;
			opts.port = chrome.port;

			//Connect puppeteer to the chrome instance,
			// as in: https://github.com/GoogleChrome/lighthouse/blob/master/docs/puppeteer.md
			// but listen for page events immediately so we don't miss any events
			return fetch(`http://localhost:${opts.port}/json/version`);
		}).then((response) => {
			return response.json();
		}).then((responseJSON) => {
			const {webSocketDebuggerUrl} = responseJSON;
    		return puppeteer.connect({defaultViewport:Pixel2.viewport, browserWSEndpoint: webSocketDebuggerUrl});
    	}).then((br) => {
			browser = br;
			if(recordDomain[recordDomain.length-1] != "/"){
				if(recordDomain.split(".").length <= 1){
					recordDomain += "/";
				}
			}
			console.log(recordDomain);
			return setPageEvents('https://' + recordDomain);
		}).then(() => {

			//Can use the debug protocol to enable a desired network condition here:
			//return setNetworkConditions();
			return Promise.resolve();
		}).then(() => {
			return lighthouse('https://' + recordDomain, opts, null);
		}).then((rpt) => {
			report = rpt;
			var recordOut = recordDomain.split("/").join("-").trim(); 
			fs.writeFileSync(dataDir + '/report-' + recordOut + ".json", JSON.stringify(report['lhr'], null, 2));
			if(!invalidPage){
				return Promise.resolve();
			}
			else{
				return Promise.reject('Main HTML did not load as expected!');
			}
		}).then(() => {
			resolve();
		}).catch((err) => {
			chrome.kill().then(() => {
				reject(err);
			});
		});
	});
}

main().then(() => {
	console.log("Success!");
	proc.exit(0);
}).catch((err) =>{
	console.error(err);
	proc.exit(1);
});
