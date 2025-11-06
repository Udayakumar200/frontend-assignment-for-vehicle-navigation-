import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './VehicleMapWithDirections.css';

/* === Helper utilities === */
const carDivIcon = new L.DivIcon({
  className: 'car-div-icon',
  html: `<svg width="44" height="24" viewBox="0 0 44 24" xmlns="http://www.w3.org/2000/svg">
      <rect rx="4" width="44" height="18" y="3" fill="#ff5722"/>
      <circle cx="12" cy="20" r="2.5" fill="#222"/>
      <circle cx="32" cy="20" r="2.5" fill="#222"/>
    </svg>`,
  iconSize: [44, 24],
  iconAnchor: [22, 12]
});

const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

function haversineKm(a, b) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const aa = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(aa));
}

/* === Click handler to collect two waypoints === */
function ClickCollector({ onAddPoint }) {
  useMapEvents({
    click(e) {
      const { lat, lng } = e.latlng;
      onAddPoint({ lat, lng });
    }
  });
  return null;
}

/* === Main component === */
export default function VehicleMapWithDirections() {
  const [clickPoints, setClickPoints] = useState([]); // up to 2 points
  const [routeCoords, setRouteCoords] = useState([]); // [{lat,lng},...]
  const [steps, setSteps] = useState([]); // directions steps list from OSRM
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1); // multiplier
  const [meta, setMeta] = useState({ coords: null, timestamp: null, elapsed: 0, speedKmh: 0 });
  const [userPos, setUserPos] = useState(null);

  const markerRef = useRef(null);
  const pastLineRef = useRef(null);
  const rafRef = useRef(null);
  const startPerfRef = useRef(null);

  // add point on map click (max 2)
  const handleAddPoint = p => {
    setClickPoints(prev => {
      if (prev.length >= 2) return [p]; // start new if already have 2
      return [...prev, p];
    });
  };

  // build OSRM route whenever clickPoints reaches 2
  useEffect(() => {
    if (clickPoints.length < 2) return;

    const buildRoute = async () => {
      try {
        // OSRM expects lon,lat pairs
        const coordsStr = clickPoints.map(p => `${p.lng},${p.lat}`).join(';');
        const osrm = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true`;
        const r = await fetch(osrm);
        if (!r.ok) throw new Error(`OSRM ${r.status}`);
        const json = await r.json();
        if (!json.routes || !json.routes.length) throw new Error('no route');

        const routeGeo = json.routes[0].geometry.coordinates; // [[lng,lat], ...]
        // convert to {lat,lng}
        const coords = routeGeo.map(c => ({ lat: c[1], lng: c[0] }));

        // collect steps: OSRM returns legs[].steps[] -> combine into a flat list
        const legs = json.routes[0].legs || [];
        const flatSteps = [];
        legs.forEach(leg => {
          leg.steps.forEach(s => {
            flatSteps.push({
              instruction: s.maneuver && s.maneuver.instruction ? s.maneuver.instruction : `${s.maneuver.type} onto ${s.name || ''}`,
              distance: s.distance, // meters
              duration: s.duration // seconds
            });
          });
        });

        // set route and steps
        setRouteCoords(coords);
        setSteps(flatSteps);

        // init marker position & meta
        setMeta({ coords: coords[0], timestamp: new Date(), elapsed: 0, speedKmh: 0 });
      } catch (err) {
        console.error('Route error', err);
        alert('Failed to fetch route: ' + err.message);
      }
    };

    buildRoute();
  }, [clickPoints]);

  // animation core: traverse routeCoords array (simple uniform sampling)
  const animate = useCallback((now) => {
    if (!startPerfRef.current) startPerfRef.current = now;
    const elapsedSim = ((now - startPerfRef.current) / 1000) * speed; // seconds scaled

    if (!routeCoords || routeCoords.length < 2) {
      rafRef.current = requestAnimationFrame(animate);
      return;
    }

    // treat each polyline segment as having equal time step by default; or weight by distance
    // We'll compute cumulative distances along the route and map elapsedSim to a fraction of total length
    const distances = [];
    let totalKm = 0;
    for (let i = 0; i < routeCoords.length - 1; i++) {
      const a = routeCoords[i], b = routeCoords[i + 1];
      const d = haversineKm(a, b);
      distances.push(d);
      totalKm += d;
    }

    // decide a virtual total duration: for demo, assume baseline 60 seconds per total route (adjustable)
    const baseTotalSec = Math.max(10, routeCoords.length * 0.5); // e.g., 0.5s per point min
    const totalSec = baseTotalSec; // you can scale based on route length if you want
    // map elapsedSim into [0,totalSec)
    const posSec = elapsedSim % totalSec;
    // compute fraction along route
    const fract = posSec / totalSec;
    let targetKm = totalKm * fract;

    // find segment where cumulative distance exceeds targetKm
    let cum = 0, segIndex = 0;
    for (let i = 0; i < distances.length; i++) {
      if (cum + distances[i] >= targetKm) { segIndex = i; break; }
      cum += distances[i];
    }
    const segStartKm = cum;
    const segKm = distances[segIndex] || 0;
    const segT = segKm > 0 ? (targetKm - segStartKm) / segKm : 0;

    const a = routeCoords[segIndex];
    const b = routeCoords[segIndex + 1] || a;
    const cur = lerp(a, b, segT);

    // update marker
    if (markerRef.current) markerRef.current.setLatLng([cur.lat, cur.lng]);

    // update past line
    if (pastLineRef.current) {
      const passed = routeCoords.slice(0, segIndex + 1).map(p => [p.lat, p.lng]);
      passed.push([cur.lat, cur.lng]);
      pastLineRef.current.setLatLngs(passed);
    }

    // compute approximate segment speed (km/h) using a small window or using pos mapping
    const approxSpeedKmh =  (segKm / ( (totalSec / routeCoords.length) / 3600 )) || 0; // crude approx
    setMeta({
      coords: cur,
      timestamp: new Date(),
      elapsed: Math.floor(posSec),
      speedKmh: approxSpeedKmh * 3 // scale to look reasonable; tweak as needed
    });

    rafRef.current = requestAnimationFrame(animate);
  }, [routeCoords, speed]);

  // play/pause effect
  useEffect(() => {
    if (playing) {
      startPerfRef.current = null;
      rafRef.current = requestAnimationFrame(animate);
    } else {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    }
    return () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [playing, animate]);

  // when routeCoords change, create marker & past polyline on map
  function MapInitializer() {
    const map = useMap();
    useEffect(() => {
      if (!routeCoords || routeCoords.length === 0) return;

      // initial marker
      const m = L.marker([routeCoords[0].lat, routeCoords[0].lng], { icon: carDivIcon }).addTo(map);
      markerRef.current = m;

      // past travel polyline
      const past = L.polyline([[routeCoords[0].lat, routeCoords[0].lng]], { color: 'green', weight: 4 }).addTo(map);
      pastLineRef.current = past;

      // fit to route
      const allLatLngs = routeCoords.map(p => [p.lat, p.lng]);
      map.fitBounds(allLatLngs, { padding: [40, 40] });

      return () => {
        if (m) map.removeLayer(m);
        if (past) map.removeLayer(past);
        markerRef.current = null;
        pastLineRef.current = null;
      };
    }, [map, routeCoords]);

    return null;
  }

  // Show my location handler
  const showMyLocation = () => {
    if (!navigator.geolocation) { alert('Geolocation not supported'); return; }
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      setUserPos({ lat, lng });
      // center map on user
      const map = markerRef.current ? markerRef.current._map : null;
      if (map) map.setView([lat, lng], 15);
    }, err => alert('Geolocation error: ' + err.message));
  };

  // reset route
  const resetRoute = () => {
    setClickPoints([]);
    setRouteCoords([]);
    setSteps([]);
    setPlaying(false);
    setMeta({ coords: null, timestamp: null, elapsed: 0, speedKmh: 0 });
  };

  return (
    <div className="vm-container">
      <div className="controls">
        <button onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</button>
        <label>Speed:
          <select value={speed} onChange={e => setSpeed(Number(e.target.value))}>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </select>
        </label>
        <button onClick={showMyLocation}>Show My Location</button>
        <button onClick={resetRoute}>Reset Route</button>

        <div className="meta">
          Coords: {meta.coords ? `${meta.coords.lat.toFixed(6)}, ${meta.coords.lng.toFixed(6)}` : '—'}
          &nbsp; Timestamp: {meta.timestamp ? meta.timestamp.toISOString() : '—'}
          &nbsp; Elapsed: {String(Math.floor(meta.elapsed / 60)).padStart(2,'0')}:{String(meta.elapsed % 60).padStart(2,'0')}
          &nbsp; Speed: {meta.speedKmh ? meta.speedKmh.toFixed(1) : '—'} km/h
        </div>
      </div>

      <div className="map-and-panel">
        <div className="map-wrap">
          <MapContainer center={[17.385044,78.486671]} zoom={13} style={{ height: '600px', width: '100%' }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OSM" />
            <ClickCollector onAddPoint={handleAddPoint} />
            {routeCoords.length > 0 && (
              <>
                <Polyline positions={routeCoords.map(p => [p.lat, p.lng])} color="blue" weight={4} />
                <MapInitializer />
              </>
            )}
            {/* show click points as markers */}
            {clickPoints.map((p, i) => (
              <Marker key={i} position={[p.lat, p.lng]} />
            ))}
            {/* show user position */}
            {userPos && <Marker position={[userPos.lat, userPos.lng]} />}
          </MapContainer>
          <div className="hint">Click on two points on the map to generate a route (click again to reset start)</div>
        </div>

        <div className="directions-panel">
          <h3>Directions</h3>
          {steps.length === 0 ? <div>No directions yet. Click two points on the map.</div> :
            <ol className="directions-list">
              {steps.map((s, i) => (
                <li key={i}>
                  <div className="instr">{s.instruction}</div>
                  <div className="meta-line">{(s.distance/1000).toFixed(2)} km &nbsp; • &nbsp; {(s.duration/60).toFixed(1)} min</div>
                </li>
              ))}
            </ol>
          }
        </div>
      </div>
    </div>
  );
}
