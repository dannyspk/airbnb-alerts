#!/usr/bin/env python3
"""
Get Airbnb listing calendar using pyairbnb library
Usage: python get_calendar.py <input_json_file> <output_json_file>
"""

import sys
import json
import pyairbnb

def get_calendar(listing_id, proxy_url=''):
    """Get calendar/availability for a specific listing"""
    try:
        data = pyairbnb.get_calendar(
            room_id=listing_id,
            currency='USD',
            proxy_url=proxy_url
        )
        
        return {
            'listing_id': listing_id,
            'calendar': data
        }
    
    except Exception as e:
        raise Exception(f"Get calendar error: {str(e)}")

def main():
    if len(sys.argv) != 3:
        print("Usage: python get_calendar.py <input_file> <output_file>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    try:
        # Read input parameters
        with open(input_file, 'r') as f:
            params = json.load(f)
        
        listing_id = params.get('listing_id')
        proxy_url = params.get('proxy_url', '')
        
        # Get calendar
        result = get_calendar(listing_id, proxy_url)
        
        # Write results
        with open(output_file, 'w') as f:
            json.dump(result, f)
        
        sys.exit(0)
    
    except Exception as e:
        error_output = {
            'error': str(e),
            'calendar': None
        }
        with open(output_file, 'w') as f:
            json.dump(error_output, f)
        sys.exit(1)

if __name__ == '__main__':
    main()
