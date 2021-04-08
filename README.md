# Browselite-Conf
Code for the Browselite system for WWW 2021.

Note that this is very much 'research' code but should act as a good primer for the
implementation of the url rewriting and refetching components of Browselite.

The code was tested on Ubuntu 18.04 using NodeJS v12.7, Lighthouse v6.1, Puppeteer v5.0, and Chromium v83.0

To run the code use NPM to install the required packages, e.g. lighthouse, lighthouse-logger, chrome-launcher, and puppeteer.

Create a data folder to store lighthouse data and run Browselite with the following:

'''
node browselite-puppeteer ./data www.independent.co.uk 0.5 true true true
'''

## Parameters

1) datadir -- where to store lighthouse logs
2) recordDomain -- url to navigate to with browselite
3) nextPct -- float to indicate what fraction of image data is requested via Range Requests
4) fillImages -- boolean to indicate whether or not to perfom image reflections with the Web Canvas
5) doReplace -- boolean to indicate whether or not replace URL patterns
6) doInterception -- boolean to indicate whether or not to actually reduce image data with rewriting/range requests

## General Flow
-- Opens the a debugging port for the page and uses lighthouse to load the page to collect various statistics.
-- All images are set to Range Request 2KB to prevent Content Layout Shifts, to fire onload events for these images, and to keep general page integrity. 
-- Images are matched to their corresponding DOM locations
-- Image URLs are run through rule-based regexes in case they can be made smaller at the server
-- Images are fetched using Range Requests at a percentage of their data as dictacted by the input parameter, 'nextPct'
-- The 2KB images are replaced with the Range Requested contents, and reflected using the Web Canvas
-- After the load of the page, lighthouse trials are recorded.






