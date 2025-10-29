let map;
let infoWindow;
let allMarkers = [];
let allFoundPlaces = [];
let searchedZones = new Set();

const CATEGORIES_TO_SEARCH = {
    'mall': 'shopping_mall',
    'school': 'school',
    'university': 'university',
    'public transport': 'transit_station',
    'point of interest': 'tourist_attraction'
};

async function initMap() {
    const { Map } = await google.maps.importLibrary("maps");
    await google.maps.importLibrary("places");
    await google.maps.importLibrary("marker");
    await google.maps.importLibrary("geometry"); // Import geometry library

    const dubaiCoords = { lat: 25.2048, lng: 55.2708 };

    map = new Map(document.getElementById('map'), {
        center: dubaiCoords,
        zoom: 11,
        mapId: 'DEMO_MAP_ID',
        gestureHandling: 'greedy'
    });

    infoWindow = new google.maps.InfoWindow();

    document.getElementById('geojson-file').addEventListener('change', handleFileSelect);
    document.getElementById('export-csv').addEventListener('click', exportToCSV);
    document.getElementById('search-all-zones-btn').addEventListener('click', handleSearchAllZones);
    document.getElementById('export-csv').disabled = true;

    map.data.setStyle(feature => ({
        fillColor: 'blue',
        fillOpacity: 0.1,
        strokeColor: 'blue',
        strokeWeight: 1
    }));

    map.data.addListener('click', async (event) => {
        const feature = event.feature;
        const areaNameProp = document.getElementById('area-name-prop').value.trim() || 'area_name';
        const zoneIndexProp = document.getElementById('zone-index-prop').value.trim() || 'zone_index';

        const zoneName = feature.getProperty(areaNameProp) || 'Unnamed Zone';
        const zoneIndex = feature.getProperty(zoneIndexProp) ?? 'N/A';
        const zoneId = `${zoneName}-${zoneIndex}`;

        if (searchedZones.has(zoneId)) {
            updateStatus(`Zone ${zoneName} has already been searched for pre-defined categories.`, 'info', 5000);
            return;
        }

        clearSearchResults();
        map.data.overrideStyle(feature, { strokeWeight: 3, strokeColor: 'red' });

        const bounds = getFeatureBounds(feature);
        map.fitBounds(bounds);

        updateStatus(`Searching for common places in ${zoneName}...`, 'loading');
        
        const polygon = getPolygonFromFeature(feature); // Create polygon for checking
        if (!polygon) {
            updateStatus(`Could not process the geometry for zone ${zoneName}. Only simple polygons are supported.`, 'error', 5000);
            return;
        }

        let placesFoundInZone = 0;
        for (const [displayName, queryType] of Object.entries(CATEGORIES_TO_SEARCH)) {
            const places = await searchPlaces(queryType, bounds);
            places.forEach(place => {
                // Check if the place is strictly inside the polygon
                if (place.location && google.maps.geometry.poly.containsLocation(place.location, polygon)) {
                    createMarker(place, displayName, zoneName, zoneIndex);
                    placesFoundInZone++;
                }
            });
        }

        if (placesFoundInZone > 0) {
            updateStatus(`Found ${placesFoundInZone} places in ${zoneName}.`, 'success', 5000);
            document.getElementById('export-csv').disabled = false;
        } else {
            updateStatus(`No new places found in ${zoneName}.`, 'info', 5000);
        }
        searchedZones.add(zoneId);
    });
}

function getPolygonFromFeature(feature) {
    const geometry = feature.getGeometry();
    if (!geometry || geometry.getType() !== 'Polygon') {
        console.warn('Skipping non-Polygon feature for geometric check.');
        return null;
    }
    const paths = geometry.getArray().map(linearRing => linearRing.getArray());
    return new google.maps.Polygon({ paths: paths });
}


function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const fileContent = e.target.result;
        try {
            // First, try to parse as a standard GeoJSON FeatureCollection
            const geoJson = JSON.parse(fileContent);
            loadGeoJsonOnMap(geoJson);
            updateStatus('GeoJSON loaded successfully. Click a zone or use the search bar.', 'success', 7000);
        } catch (error) {
            // If standard parsing fails, assume it might be newline-delimited GeoJSON (GeoJSONL)
            if (error instanceof SyntaxError) {
                console.warn('Initial JSON.parse failed. Attempting to parse as newline-delimited GeoJSON.', error);
                
                const lines = fileContent.trim().split(/\r?\n/).filter(line => line.trim() !== '');
                const validFeatures = [];
                const parsingErrors = [];

                lines.forEach((line, index) => {
                    try {
                        const feature = JSON.parse(line);
                        // Basic validation to ensure it looks like a GeoJSON feature
                        if (feature.type === 'Feature' && feature.geometry) {
                            validFeatures.push(feature);
                        } else {
                            parsingErrors.push(index + 1);
                        }
                    } catch (lineError) {
                        parsingErrors.push(index + 1);
                    }
                });

                if (validFeatures.length > 0) {
                    const featureCollection = {
                        type: "FeatureCollection",
                        features: validFeatures
                    };
                    loadGeoJsonOnMap(featureCollection);

                    if (parsingErrors.length > 0) {
                        const errorLines = parsingErrors.join(', ');
                        updateStatus(`Loaded ${validFeatures.length} features. Could not parse lines: ${errorLines}.`, 'info', 15000);
                        console.warn(`Could not parse the following lines from the GeoJSONL file: ${errorLines}`);
                    } else {
                        updateStatus(`Newline-delimited GeoJSON loaded successfully with ${validFeatures.length} features.`, 'success', 7000);
                    }
                } else {
                    updateStatus(`Error: No valid GeoJSON features could be parsed from the file.`, 'error', 10000);
                }

            } else {
                console.error('Error reading GeoJSON file:', error);
                updateStatus('Error: Could not read the GeoJSON file.', 'error', 5000);
            }
        }
    };
    reader.readAsText(file);
}

function loadGeoJsonOnMap(geoJson) {
    resetMapState();
    const zoneIndexProp = document.getElementById('zone-index-prop').value.trim() || 'zone_index';
    if (geoJson.type === 'FeatureCollection' && Array.isArray(geoJson.features)) {
        geoJson.features.forEach((feature, index) => {
            if (!feature.properties) {
                feature.properties = {};
            }
            if (feature.properties[zoneIndexProp] === undefined) {
                feature.properties[zoneIndexProp] = index;
            }
        });
        map.data.addGeoJson(geoJson);
        zoomToDataLayer();
    } else {
        throw new Error('Processed file is not a valid GeoJSON FeatureCollection.');
    }
}

function resetMapState() {
    map.data.forEach(feature => map.data.remove(feature));
    clearSearchResults();
}

function clearSearchResults() {
    allMarkers.forEach(marker => marker.map = null);
    allMarkers = [];
    allFoundPlaces = [];
    searchedZones.clear();
    document.getElementById('results-list').innerHTML = '';
    document.getElementById('export-csv').disabled = true;
    map.data.revertStyle();
}

async function handleSearchAllZones() {
    const query = document.getElementById('amenity-search-input').value.trim();
    if (!query) {
        updateStatus('Please enter an amenity to search for.', 'error', 3000);
        return;
    }

    let hasFeatures = false;
    map.data.forEach(() => { hasFeatures = true; });
    if (!hasFeatures) {
        updateStatus('Please upload a GeoJSON file first.', 'error', 3000);
        return;
    }

    clearSearchResults();
    updateStatus(`Searching all zones for '${query}'...`, 'loading');
    const searchButton = document.getElementById('search-all-zones-btn');
    searchButton.disabled = true;

    const areaNameProp = document.getElementById('area-name-prop').value.trim() || 'area_name';
    const zoneIndexProp = document.getElementById('zone-index-prop').value.trim() || 'zone_index';

    const searchPromises = [];
    map.data.forEach(feature => {
        const bounds = getFeatureBounds(feature);
        const searchPromise = searchPlaces(query, bounds).then(places => {
            return { places, feature };
        });
        searchPromises.push(searchPromise);
    });

    const resultsByZone = await Promise.all(searchPromises);

    let totalPlacesFound = 0;
    for (const result of resultsByZone) {
        const { places, feature } = result;
        const polygon = getPolygonFromFeature(feature);

        if (places.length > 0 && polygon) {
            const zoneName = feature.getProperty(areaNameProp) || 'Unnamed Zone';
            const zoneIndex = feature.getProperty(zoneIndexProp) ?? 'N/A';

            places.forEach(place => {
                if (place.location && google.maps.geometry.poly.containsLocation(place.location, polygon)) {
                    createMarker(place, query, zoneName, zoneIndex);
                    totalPlacesFound++;
                }
            });
        }
    }

    if (totalPlacesFound > 0) {
        updateStatus(`Found ${totalPlacesFound} results for '${query}' across all zones.`, 'success', 5000);
        document.getElementById('export-csv').disabled = false;
    } else {
        updateStatus(`No results found for '${query}' in any zone.`, 'info', 5000);
    }

    searchButton.disabled = false;
}

function zoomToDataLayer() {
    const bounds = new google.maps.LatLngBounds();
    map.data.forEach(feature => {
        feature.getGeometry().forEachLatLng(latlng => bounds.extend(latlng));
    });
    if (!bounds.isEmpty()) {
        map.fitBounds(bounds);
    }
}

function getFeatureBounds(feature) {
    const bounds = new google.maps.LatLngBounds();
    feature.getGeometry().forEachLatLng(latlng => bounds.extend(latlng));
    return bounds;
}

async function searchPlaces(query, locationBias) {
    const { Place } = await google.maps.importLibrary("places");
    const request = {
        textQuery: query,
        fields: ['displayName', 'location', 'formattedAddress'],
        locationBias: locationBias,
        maxResultCount: 20
    };

    try {
        const { places } = await Place.searchByText(request);
        return places;
    } catch (error) {
        console.error(`Search failed for ${query}:`, error);
        updateStatus(`Search failed for ${query}. Check console.`, 'error', 5000);
        return [];
    }
}

async function createMarker(place, category, zoneName, zoneIndex) {
    if (!place.location) return;

    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

    const marker = new AdvancedMarkerElement({
        map,
        position: place.location,
        title: place.displayName
    });

    marker.addListener('gmp-click', () => {
        infoWindow.setContent(`<strong>${place.displayName}</strong><br>Category: ${category}<br>${place.formattedAddress || ''}`);
        infoWindow.open(map, marker);
    });

    allMarkers.push(marker);
    const placeData = {
        name: place.displayName,
        category: category,
        areaName: zoneName,
        zoneIndex: zoneIndex,
        latitude: place.location.lat(),
        longitude: place.location.lng()
    };
    allFoundPlaces.push(placeData);
    updateResultsList(placeData);
}

function updateResultsList(placeData) {
    const resultsList = document.getElementById('results-list');
    const item = document.createElement('div');
    item.className = 'p-2 border-b hover:bg-gray-50';
    item.innerHTML = `
        <p class="font-semibold">${placeData.name}</p>
        <p class="text-gray-600">Category: ${placeData.category}</p>
        <p class="text-gray-600">Zone: ${placeData.areaName} (${placeData.zoneIndex})</p>
        <p class="text-gray-500 text-xs">Lat: ${placeData.latitude.toFixed(6)}, Lng: ${placeData.longitude.toFixed(6)}</p>
    `;
    resultsList.prepend(item);
}

function exportToCSV() {
    if (allFoundPlaces.length === 0) {
        updateStatus('No results to export.', 'info', 3000);
        return;
    }

    const headers = ['Name', 'Category', 'Area Name', 'Zone Index', 'Latitude', 'Longitude'];
    const rows = allFoundPlaces.map(place => 
        [place.name, place.category, place.areaName, place.zoneIndex, place.latitude, place.longitude].map(field => `\"${String(field).replace(/\"/g, '""')}\"`).join(',')
    );

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'dubai_amenities.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function updateStatus(message, type = 'info', duration = 0) {
    const statusContainer = document.getElementById('status-container');
    const statusMessage = document.getElementById('status-message');
    const statusText = document.getElementById('status-text');
    const statusIcon = statusMessage.querySelector('.material-icons');

    statusContainer.classList.remove('hidden');
    statusMessage.className = 'text-sm p-3 rounded-md flex items-center'; // Reset classes

    switch (type) {
        case 'loading':
            statusMessage.classList.add('bg-yellow-100', 'text-yellow-800');
            statusIcon.textContent = 'sync';
            statusIcon.classList.add('animate-spin');
            break;
        case 'success':
            statusMessage.classList.add('bg-green-100', 'text-green-800');
            statusIcon.textContent = 'check_circle';
            statusIcon.classList.remove('animate-spin');
            break;
        case 'error':
            statusMessage.classList.add('bg-red-100', 'text-red-800');
            statusIcon.textContent = 'error';
            statusIcon.classList.remove('animate-spin');
            break;
        default: // info
            statusMessage.classList.add('bg-blue-100', 'text-blue-800');
            statusIcon.textContent = 'info';
            statusIcon.classList.remove('animate-spin');
            break;
    }

    statusText.textContent = message;

    if (duration > 0) {
        setTimeout(() => {
            statusContainer.classList.add('hidden');
        }, duration);
    }
}

initMap();