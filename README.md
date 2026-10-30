# RTP Route Finder

Indoor route finder for Research Techno Plaza (NTU), built by the smARtNAV team: type where you are and where you
want to go, see the route on the floor plan and in 3D side by side, drag along it in either view, or fly through it.

Live page: https://archiekenichi.github.io/smartnav-routefinder/

A route can be linked directly, for example
[Entrance 2 to ERI@N Cleanroom 1](https://archiekenichi.github.io/smartnav-routefinder/?from=entrance:2&to=RTP-XF-05-10).

This repository holds only the generated, self-contained bundle (`python3 mapping/preview3d/make_bundle.py` in the
smartnav repository, branch `mapping`). Do not edit these files here: change `mapping/preview3d/` there, rebuild the
bundle and push it again (`mapping/preview3d/publish_pages.sh`).

Floor-plan geometry comes from MazeMap (building 1014912); positions are typically within 1 m and doors are not yet
surveyed on site. Routing, map and 3D run entirely in the browser; nothing is sent anywhere.
