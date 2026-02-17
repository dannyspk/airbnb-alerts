#!/usr/bin/env python3
"""
Get Airbnb listing details using pyairbnb library
Usage: python get_listing.py <input_json_file> <output_json_file>
"""

import sys
import json
import pyairbnb

def get_listing_details(listing_id, currency='USD', proxy_url=''):
    """Get detailed information for a specific listing"""
    try:
        data = pyairbnb.get_details(
            room_id=listing_id,
            currency=currency,
            proxy_url=proxy_url
        )
        
        return {
            'id': listing_id,
            'name': data.get('name'),
            'description': data.get('description'),
            'price': data.get('price'),
            'currency': currency,
            'rating': data.get('rating'),
            'reviewsCount': data.get('reviewsCount', 0),
            'roomType': data.get('roomType'),
            'guests': data.get('guests'),
            'bedrooms': data.get('bedrooms'),
            'beds': data.get('beds'),
            'bathrooms': data.get('bathrooms'),
            'address': data.get('address'),
            'lat': data.get('lat'),
            'lng': data.get('lng'),
            'amenities': data.get('amenities', []),
            'hostId': data.get('hostId'),
            'hostName': data.get('hostName'),
            'photos': data.get('photos', []),
            'url': data.get('url')
        }
    
    except Exception as e:
        raise Exception(f"Get listing error: {str(e)}")

def main():
    if len(sys.argv) != 3:
        print("Usage: python get_listing.py <input_file> <output_file>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    try:
        # Read input parameters
        with open(input_file, 'r') as f:
            params = json.load(f)
        
        listing_id = params.get('listing_id')
        currency = params.get('currency', 'USD')
        proxy_url = params.get('proxy_url', '')
        
        # Get listing details
        result = get_listing_details(listing_id, currency, proxy_url)
        
        # Write results
        with open(output_file, 'w') as f:
            json.dump(result, f)
        
        sys.exit(0)
    
    except Exception as e:
        error_output = {
            'error': str(e),
            'listing': None
        }
        with open(output_file, 'w') as f:
            json.dump(error_output, f)
        sys.exit(1)

if __name__ == '__main__':
    main()
