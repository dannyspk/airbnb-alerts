#!/usr/bin/env python3
"""
Search Airbnb listings using pyairbnb library
Usage: python search_listings.py <input_json_file> <output_json_file>
"""

import sys
import json
import pyairbnb

def search_listings(params):
    """Search Airbnb listings with given parameters"""
    try:
        # Extract search parameters
        check_in = params.get('check_in')
        check_out = params.get('check_out')
        ne_lat = params.get('ne_lat')
        ne_long = params.get('ne_long')
        sw_lat = params.get('sw_lat')
        sw_long = params.get('sw_long')
        price_min = params.get('price_min', 0)
        price_max = params.get('price_max', 0)
        guests = params.get('guests', 1)
        place_type = params.get('place_type', '')
        amenities = params.get('amenities', [])
        free_cancellation = params.get('free_cancellation', False)
        currency = params.get('currency', 'USD')
        proxy_url = params.get('proxy_url', '')
        
        # Call pyairbnb
        results = pyairbnb.search_all(
            check_in=check_in,
            check_out=check_out,
            ne_lat=ne_lat,
            ne_long=ne_long,
            sw_lat=sw_lat,
            sw_long=sw_long,
            zoom_value=10,
            price_min=price_min,
            price_max=price_max,
            place_type=place_type,
            amenities=amenities,
            free_cancellation=free_cancellation,
            currency=currency,
            proxy_url=proxy_url
        )
        
        # Normalize/format results (be tolerant to different pyairbnb output shapes)
        formatted_results = []
        for listing in results:
            # helper to pick first-available key
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

            # price may be a number or a nested dict coming from standardize
            price = pick('price', 'price_total', 'priceValue')

            photos = pick('photos', 'images') or []

            lat = None
            lng = None
            loc = pick('location', 'coordinates') or {}
            if isinstance(loc, dict):
                lat = loc.get('lat') or loc.get('latitude')
                lng = loc.get('lng') or loc.get('longitude')

            formatted_results.append({
                'id': listing_id,
                'url': pick('url', 'listing_url'),
                'name': pick('name', 'title'),
                'price': price,
                'currency': currency,
                'rating': pick('rating', 'stars', 'score'),
                'reviewsCount': pick('reviewsCount', 'review_count', 'numberOfGuests') or 0,
                'roomType': pick('roomType', 'type'),
                'guests': pick('guests', 'person_capacity'),
                'address': pick('address', 'location_address'),
                'lat': lat,
                'lng': lng,
                'hostId': pick('hostId', 'host_id'),
                    'hostName': pick('hostName', 'host_name'),
                    # host superhost flag (if provided by pyairbnb)
                    'hostIsSuperhost': pick('hostIsSuperhost', 'host_is_superhost') or (
                        isinstance(listing.get('host'), dict) and (listing.get('host').get('is_superhost') or listing.get('host').get('isSuperhost'))
                    ),
                'photos': photos
            })

        return formatted_results
    
    except Exception as e:
        raise Exception(f"Search error: {str(e)}")

def main():
    if len(sys.argv) != 3:
        print("Usage: python search_listings.py <input_file> <output_file>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    try:
        # Read input parameters
        with open(input_file, 'r') as f:
            params = json.load(f)
        
        # Search listings
        results = search_listings(params)
        
        # Write results
        with open(output_file, 'w') as f:
            json.dump(results, f)
        
        sys.exit(0)
    
    except Exception as e:
        error_output = {
            'error': str(e),
            'results': []
        }
        with open(output_file, 'w') as f:
            json.dump(error_output, f)
        sys.exit(1)

if __name__ == '__main__':
    main()
