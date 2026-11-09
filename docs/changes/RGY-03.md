# RGY-03 — Independent grader configuration parity

Mirror the optional `osg.rgy.grader` budget and arm declarations in the shared
OSG schema. The grader is an explicit, decision-only consumer in the parent
runtime. This service does not launch it or change review/merge behavior.
No configuration or stored grades are changed on deployment.
