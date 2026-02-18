#!/usr/bin/env python3
"""
Search Airbnb listings using pyairbnb library.

Supports two modes:
  1. URL mode  – pass {"search_url": "https://www.airbnb.com/s/..."} and the
                 raw Airbnb search URL is forwarded directly to pyairbnb.
  2. Params mode – pass individual fields (legacy / search-form flow).

Usage: python search_listings.py <input_json_file> <output_json_file>
"""

import sys
import json
import pyairbnb


def normalize_listing(listing, currency='USD'):
    """Normalise a raw pyairbnb result dict into our standard shape."""
    def pick(*keys):
        for k in keys:
            v = listing.get(k)
            if v is not None:
                return v
        return None

    raw_id = pick('id', 'room_id', 'roomId', 'listingId')
    try:
        listing_id = str(int(raw_id)) if raw_id is not None else None
    except Exception:
        listing_id = str(raw_id) if raw_id is not None else None

    price = pick('price', 'price_total', 'priceValue')

    photos = pick('photos', 'images') or []

    lat = lng = None
    loc = pick('location', 'coordinates') or {}
    if isinstance(loc, dict):
        lat = loc.get('lat') or loc.get('latitude')
        lng = loc.get('lng') or loc.get('longitude')

    return {
        'id': listing_id,
        'url': pick('url', 'listing_url'),
        'name': pick('name', 'title'),
        'price': price,
        'currency': currency,
        'rating': pick('rating', 'stars', 'score'),
        'reviewsCount': pick('reviewsCount', 'review_count', 'reviews') or 0,
        'roomType': pick('roomType', 'type'),
        'guests': pick('guests', 'person_capacity'),
        'address': pick('address', 'location_address'),
        'lat': lat,
        'lng': lng,
        'hostId': pick('hostId', 'host_id'),
        'hostName': pick('hostName', 'host_name'),
        'hostIsSuperhost': pick('hostIsSuperhost', 'host_is_superhost') or (
            isinstance(listing.get('host'), dict) and (
                listing['host'].get('is_superhost') or listing['host'].get('isSuperhost')
            )
        ),
        'photos': photos,
    }


def search_by_url(search_url, currency='USD', proxy_url=''):
    """Search using a full Airbnb search URL — pyairbnb handles all param parsing."""
    results = pyairbnb.search_all(
        url=search_url,
        currency=currency,
        proxy_url=proxy_url,
    )
    return [normalize_listing(r, currency) for r in results]


def search_by_params(params):
    """Search using individual parameters (legacy form-based flow)."""
    currency = params.get('currency', 'USD')
    results = pyairbnb.search_all(
        check_in=params.get('check_in'),
        check_out=params.get('check_out'),
        ne_lat=params.get('ne_lat'),
        ne_long=params.get('ne_long'),
        sw_lat=params.get('sw_lat'),
        sw_long=params.get('sw_long'),
        zoom_value=params.get('zoom_value', 10),
        price_min=params.get('price_min', 0),
        price_max=params.get('price_max', 0),
        place_type=params.get('place_type', ''),
        amenities=params.get('amenities', []),
        free_cancellation=params.get('free_cancellation', False),
        currency=currency,
        proxy_url=params.get('proxy_url', ''),
    )
    return [normalize_listing(r, currency) for r in results]


def main():
    if len(sys.argv) != 3:
        print("Usage: python search_listings.py <input_file> <output_file>")
        sys.exit(1)

    input_file  = sys.argv[1]
    output_file = sys.argv[2]

    try:
        with open(input_file, 'r') as f:
            params = json.load(f)

        # Prefer URL-based search when a search_url is provided
        if params.get('search_url'):
            results = search_by_url(
                search_url=params['search_url'],
                currency=params.get('currency', 'USD'),
                proxy_url=params.get('proxy_url', ''),
            )
        else:
            results = search_by_params(params)

        with open(output_file, 'w') as f:
            json.dump(results, f)

        sys.exit(0)

    except Exception as e:
        with open(output_file, 'w') as f:
            json.dump({'error': str(e), 'results': []}, f)
        sys.exit(1)


if __name__ == '__main__':
    main()
